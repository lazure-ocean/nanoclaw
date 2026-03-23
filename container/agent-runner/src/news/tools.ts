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
  getIngestStats,
  getLatestItems,
  getAllSources,
  insertSource,
  deactivateSource,
  activateSource,
} from './db.js';
import { seedSources } from './sources-seed.js';
import { pollRssFeeds } from './rss-poller.js';

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
}
