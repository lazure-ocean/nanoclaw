/**
 * News RSS — MCP tool registration
 *
 * Registers news tools on the NanoClaw MCP server so the container agent
 * can query, poll, and manage news sources.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  initNewsDb,
  getDb,
  getIngestStats,
  getLatestItems,
  getAllSources,
  insertSource,
  deactivateSource,
  activateSource,
} from './db.js';
import { seedSources } from './sources-seed.js';
import { pollRssFeeds } from './rss-poller.js';
import { classifyBatch } from './classifier.js';

const NEWS_DB_PATH = '/workspace/group/news.db';

let initPromise: Promise<void> | null = null;

async function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = initNewsDb(NEWS_DB_PATH).then(() => { seedSources(); });
  }
  return initPromise;
}

export function registerNewsTools(server: McpServer): void {
  server.tool(
    'news_status',
    'Get news ingestion status: source count, item count, unclassified count, last poll time.',
    {},
    async () => {
      ensureInit();
      const stats = getIngestStats();
      const lines = [
        `Sources: ${stats.active_sources} active / ${stats.total_sources} total`,
        `Items: ${stats.total_items} total, ${stats.unclassified} unclassified`,
        `Last poll: ${stats.last_ingest ?? 'never'}`,
      ];
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  server.tool(
    'news_poll_now',
    'Manually trigger an RSS feed poll. Fetches all active RSS sources and returns how many items were fetched/new.',
    {},
    async () => {
      ensureInit();
      const result = await pollRssFeeds();
      const lines = [`Fetched: ${result.fetched} items, ${result.newItems} new`];
      if (result.perSource.length > 0) {
        lines.push('');
        for (const s of result.perSource) {
          lines.push(`  ${s.source}: ${s.fetched} fetched, ${s.new} new`);
        }
      }
      if (result.errors.length > 0) {
        lines.push('');
        lines.push('Errors:');
        for (const e of result.errors) {
          lines.push(`  ${e.source}: ${e.error}`);
        }
      }
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  server.tool(
    'news_latest',
    'Get the most recent news items. Optionally filter by source_id.',
    {
      count: z.number().min(1).max(50).default(10).describe('Number of items (default 10, max 50)'),
      source_id: z.string().optional().describe("Filter by source ID, e.g. 'rss:reuters-world'"),
    },
    async (args) => {
      ensureInit();
      const items = getLatestItems(args.count, args.source_id);
      if (items.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No news items found.' }] };
      }
      const lines = items.map((item, i) => {
        const source = item.source_id.replace('rss:', '');
        const date = item.published_at?.slice(0, 10) ?? '?';
        return `${i + 1}. [${source}] ${item.title ?? '(no title)'} (${date})\n   ${item.url ?? ''}`;
      });
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  server.tool(
    'news_sources',
    'List all configured news sources with their status.',
    {},
    async () => {
      ensureInit();
      const sources = getAllSources();
      if (sources.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No news sources configured.' }] };
      }
      const lines = sources.map((s) => {
        const status = s.active ? '✓' : '✗';
        const topics = s.default_topics ? JSON.parse(s.default_topics).join(', ') : '';
        return `${status} ${s.id} — ${s.name} [${s.language}] ${s.default_depth ?? ''} ${topics}`;
      });
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  server.tool(
    'news_add_source',
    'Add a new RSS source to the news system.',
    {
      id: z.string().describe("Unique source ID, e.g. 'rss:nytimes'"),
      name: z.string().describe('Human-readable name'),
      url: z.string().describe('RSS feed URL'),
      topics: z.string().optional().describe('Comma-separated default topics'),
      depth: z.enum(['breaking', 'opinion', 'analysis', 'longform']).optional().describe('Default depth type'),
      language: z.string().default('en').describe('Content language: en, ru, sr, etc.'),
    },
    async (args) => {
      ensureInit();
      const topicsJson = args.topics
        ? JSON.stringify(args.topics.split(',').map((t) => t.trim()))
        : null;
      try {
        insertSource({
          id: args.id,
          type: 'rss',
          name: args.name,
          url: args.url,
          default_topics: topicsJson ?? undefined,
          default_depth: args.depth,
          language: args.language,
        });
        return { content: [{ type: 'text' as const, text: `Source "${args.name}" (${args.id}) added.` }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Failed to add source: ${msg}` }], isError: true };
      }
    },
  );

  server.tool(
    'news_toggle_source',
    'Activate or deactivate a news source.',
    {
      id: z.string().describe('Source ID to toggle'),
      active: z.boolean().describe('true to activate, false to deactivate'),
    },
    async (args) => {
      ensureInit();
      const ok = args.active ? activateSource(args.id) : deactivateSource(args.id);
      if (!ok) {
        return { content: [{ type: 'text' as const, text: `Source "${args.id}" not found.` }], isError: true };
      }
      const verb = args.active ? 'activated' : 'deactivated';
      return { content: [{ type: 'text' as const, text: `Source "${args.id}" ${verb}.` }] };
    },
  );

  // ── Classification tools ───────────────────────────────────────────

  server.tool(
    'news_classify_now',
    'Classify unclassified news items using a local Ollama LLM. Processes up to 50 items in batches of 5. Returns timing stats per batch.',
    {
      max_items: z.number().min(1).max(200).default(50).describe('Max items to classify (default 50)'),
    },
    async (args) => {
      await ensureInit();
      const result = await classifyBatch(args.max_items);
      const lines = [`Classified: ${result.classified} items in ${result.batches} batches`];
      if (result.timing.length > 0) {
        lines.push('');
        lines.push('Timing:');
        for (const t of result.timing) {
          const secs = (t.durationMs / 1000).toFixed(1);
          const totalTok = (t.promptTokens ?? 0) + (t.evalTokens ?? 0);
          const perf = t.tokensPerSec ? ` · ${t.tokensPerSec} eval t/s · ${totalTok} tokens` : '';
          lines.push(`  Batch ${t.batch}: ${t.items} items in ${secs}s${perf}`);
        }
        const totalMs = result.timing.reduce((sum, t) => sum + t.durationMs, 0);
        lines.push(`  Total: ${(totalMs / 1000).toFixed(1)}s`);
      }
      if (result.errors.length > 0) {
        lines.push('');
        lines.push('Errors:');
        for (const e of result.errors) {
          lines.push(`  ${e}`);
        }
      }
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  server.tool(
    'news_search',
    'Search classified news items by topic, region, depth, credibility, relevance, and time range.',
    {
      topic: z.string().optional().describe('Filter by topic (e.g. "geopolitics", "economics")'),
      region: z.string().optional().describe('Filter by region (e.g. "Russia", "Europe")'),
      depth: z.enum(['breaking', 'opinion', 'analysis', 'longform']).optional().describe('Filter by depth type'),
      min_credibility: z.number().min(0).max(1).optional().describe('Minimum credibility score (0.0-1.0)'),
      min_relevance: z.number().min(0).max(1).optional().describe('Minimum relevance score (0.0-1.0)'),
      days: z.number().min(1).max(30).default(7).describe('Look back N days (default 7)'),
      limit: z.number().min(1).max(50).default(20).describe('Max results (default 20)'),
    },
    async (args) => {
      await ensureInit();
      const d = getDb();

      const conditions: string[] = [];
      const params: (string | number)[] = [];

      if (args.topic) {
        conditions.push("c.topics LIKE '%' || ? || '%'");
        params.push(args.topic);
      }
      if (args.region) {
        conditions.push("c.regions LIKE '%' || ? || '%'");
        params.push(args.region);
      }
      if (args.depth) {
        conditions.push('c.depth_type = ?');
        params.push(args.depth);
      }
      if (args.min_credibility !== undefined) {
        conditions.push('c.credibility_score >= ?');
        params.push(args.min_credibility);
      }
      if (args.min_relevance !== undefined) {
        conditions.push('c.relevance >= ?');
        params.push(args.min_relevance);
      }
      conditions.push("r.published_at >= datetime('now', '-' || ? || ' days')");
      params.push(args.days);
      params.push(args.limit);

      const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
      const sql = `
        SELECT c.*, r.title, r.url, r.source_id, r.published_at
        FROM news_classified c
        JOIN news_raw r ON c.raw_id = r.id
        ${where}
        ORDER BY r.published_at DESC
        LIMIT ?
      `;

      const stmt = d.prepare(sql);
      stmt.bind(params);
      const results: Array<Record<string, unknown>> = [];
      while (stmt.step()) {
        results.push(stmt.getAsObject());
      }
      stmt.free();

      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No matching classified items found.' }] };
      }

      const lines = results.map((r, i) => {
        const topics = r.topics ? JSON.parse(r.topics as string).join(', ') : '';
        const regions = r.regions ? JSON.parse(r.regions as string).join(', ') : '';
        const cred = `${r.credibility} (${(r.credibility_score as number)?.toFixed(1)})`;
        const rel = (r.relevance as number)?.toFixed(1);
        const date = (r.published_at as string)?.slice(0, 10) ?? '?';
        const source = (r.source_id as string)?.replace('rss:', '') ?? '';
        return `${i + 1}. [${source}] ${r.title}\n   ${date} · ${r.depth_type} · ${cred} · rel:${rel}\n   Topics: ${topics} · Regions: ${regions}\n   ${r.summary}\n   ${r.url ?? ''}`;
      });

      return { content: [{ type: 'text' as const, text: lines.join('\n\n') }] };
    },
  );

  server.tool(
    'news_clusters',
    'Show recent story clusters grouped by cluster_id, with source counts and credibility range.',
    {
      days: z.number().min(1).max(30).default(3).describe('Look back N days (default 3)'),
      limit: z.number().min(1).max(30).default(15).describe('Max clusters (default 15)'),
    },
    async (args) => {
      await ensureInit();
      const d = getDb();

      const sql = `
        SELECT
          c.cluster_id,
          COUNT(*) as item_count,
          GROUP_CONCAT(DISTINCT r.source_id) as sources,
          MIN(c.credibility_score) as min_cred,
          MAX(c.credibility_score) as max_cred,
          MAX(c.relevance) as max_relevance,
          c.depth_type,
          c.topics,
          c.regions,
          (SELECT r2.title FROM news_raw r2 JOIN news_classified c2 ON c2.raw_id = r2.id WHERE c2.cluster_id = c.cluster_id ORDER BY c2.credibility_score DESC LIMIT 1) as best_title,
          (SELECT c3.summary FROM news_classified c3 WHERE c3.cluster_id = c.cluster_id ORDER BY c3.credibility_score DESC LIMIT 1) as best_summary
        FROM news_classified c
        JOIN news_raw r ON c.raw_id = r.id
        WHERE r.published_at >= datetime('now', '-' || ? || ' days')
        GROUP BY c.cluster_id
        ORDER BY max_relevance DESC, item_count DESC
        LIMIT ?
      `;

      const stmt = d.prepare(sql);
      stmt.bind([args.days, args.limit]);
      const clusters: Array<Record<string, unknown>> = [];
      while (stmt.step()) {
        clusters.push(stmt.getAsObject());
      }
      stmt.free();

      if (clusters.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No classified clusters found in the time range.' }] };
      }

      const lines = clusters.map((cl, i) => {
        const sources = (cl.sources as string)?.split(',').map((s) => s.replace('rss:', '')).join(', ') ?? '';
        const credRange = `${(cl.min_cred as number)?.toFixed(1)}-${(cl.max_cred as number)?.toFixed(1)}`;
        const topics = cl.topics ? JSON.parse(cl.topics as string).join(', ') : '';
        return `${i + 1}. ${cl.best_title}\n   Cluster: ${cl.cluster_id} · ${cl.item_count} items · Sources: ${sources}\n   Credibility: ${credRange} · Relevance: ${(cl.max_relevance as number)?.toFixed(1)} · ${cl.depth_type}\n   Topics: ${topics}\n   ${cl.best_summary ?? ''}`;
      });

      return { content: [{ type: 'text' as const, text: lines.join('\n\n') }] };
    },
  );
}
