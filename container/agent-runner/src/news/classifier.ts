/**
 * News Classify — Batch classification using local Ollama LLM
 *
 * Reads unclassified items from news_raw, sends them in batches to a local
 * Ollama model (via OpenAI-compatible API), writes results to news_classified,
 * and marks raw items as classified. Includes per-batch timing for performance tracking.
 */

import {
  getDb,
  getUnclassifiedItems,
  save,
  type Source,
} from './db.js';
import { getItemContent } from './fetch-full.js';

const BATCH_SIZE = 5;
const MODEL = process.env.NEWS_CLASSIFY_MODEL || 'qwen3:8b';
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const MAX_CONTENT_CHARS = 1500;

interface ClassifiedItem {
  raw_id: number;
  topics: string[];
  regions: string[];
  depth_type: string;
  cluster_id: string;
  relevance: number;
  credibility: string;
  credibility_score: number;
  credibility_signals: {
    named_sources: boolean;
    multiple_corroboration: boolean;
    speculative_language: boolean;
    opinion_framed_as_fact: boolean;
    official_statement: boolean;
  };
  summary: string;
  language: string;
}

export interface ClassifyResult {
  classified: number;
  batches: number;
  errors: string[];
  timing: BatchTiming[];
}

interface BatchTiming {
  batch: number;
  items: number;
  durationMs: number;
  promptTokens?: number;
  evalTokens?: number;
  tokensPerSec?: number;
}

function log(msg: string): void {
  console.error(`[news-classify] ${msg}`);
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function fmtKb(chars: number): string {
  return `${(chars / 1024).toFixed(1)}kb`;
}

function buildPrompt(items: Array<{ id: number; source: string; bias_hint: string | null; title: string; content: string; url: string | null; published_at: string | null }>): string {
  const itemsBlock = items.map((item, i) => `
<item index="${i}" raw_id="${item.id}" source="${item.source}" bias_hint="${item.bias_hint || 'none'}">
  <title>${item.title}</title>
  <published>${item.published_at || 'unknown'}</published>
  <url>${item.url || ''}</url>
  <content>${item.content.slice(0, MAX_CONTENT_CHARS)}</content>
</item>`).join('\n');

  return `You are a news intelligence classifier. Analyze each news item and output structured classification data.

## Items to classify
${itemsBlock}

## Output format

Return a JSON array with one object per item. Each object must have:

\`\`\`json
{
  "raw_id": <number>,
  "topics": <string[]>,
  "regions": <string[]>,
  "depth_type": <string>,
  "cluster_id": <string>,
  "relevance": <float>,
  "credibility": <string>,
  "credibility_score": <float>,
  "credibility_signals": {
    "named_sources": <bool>,
    "multiple_corroboration": <bool>,
    "speculative_language": <bool>,
    "opinion_framed_as_fact": <bool>,
    "official_statement": <bool>
  },
  "summary": <string>,
  "language": <string>
}
\`\`\`

## Field rules

- **topics**: one or more from: geopolitics, economics, science, technology, culture, local
- **regions**: one or more from: Russia, Ukraine, Europe, USA, Israel, Serbia, Moscow, Belgrade, Tel Aviv, Global
- **depth_type**: breaking | opinion | analysis | longform
- **cluster_id**: snake_case story identifier shared across items covering the same story (e.g. "ukraine_ceasefire_talks_mar26"). If a story is unique to one item, still give it a descriptive cluster_id.
- **relevance**: 0.0-1.0 relevance to a user interested in geopolitics, economics, Russia, Europe, and technology
- **credibility**: verified | likely | unconfirmed | speculative
  - Use the source's bias_hint as a prior — biased source + well-sourced item can still be "likely", but unsourced claims from biased sources → "speculative"
  - Headline-only items with no substantive content → "unconfirmed"
- **credibility_score**: 0.0-1.0 matching the credibility label
- **credibility_signals**: analyze the content for each signal
- **summary**: 2-3 sentences, factual, not editorialized. For opinions, summarize the argument. Write in the same language as the source content.
- **language**: detected language code (en, ru, sr, ua, etc.)

## Important

- When multiple items in this batch cover the same story, assign the same cluster_id and note corroboration in credibility_signals.multiple_corroboration
- Return ONLY the JSON array, no other text. Do not use thinking tags or explanations.`;
}

function repairJson(raw: string): string {
  let s = raw;
  // Strip thinking tags
  s = s.replace(/<think>[\s\S]*?<\/think>/g, '');
  // Strip markdown code fences
  s = s.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '');
  // Extract the JSON array (or single object)
  const arrayMatch = s.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    s = arrayMatch[0];
  } else {
    // Single object? Wrap in array.
    const objMatch = s.match(/\{[\s\S]*\}/);
    if (objMatch) {
      s = `[${objMatch[0]}]`;
    } else {
      throw new Error(`No JSON found in response (${raw.length} chars, starts: "${raw.slice(0, 120)}...")`);
    }
  }
  // Fix trailing commas before ] or }
  s = s.replace(/,\s*([}\]])/g, '$1');
  // Fix truncated JSON: try to close unclosed brackets/braces
  // Count open vs close
  let braces = 0, brackets = 0;
  let inString = false, escaped = false;
  for (const ch of s) {
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') braces++;
    else if (ch === '}') braces--;
    else if (ch === '[') brackets++;
    else if (ch === ']') brackets--;
  }
  // Close any unclosed strings (heuristic: if inString, add closing quote)
  if (inString) s += '"';
  // Close unclosed braces/brackets
  while (braces > 0) { s += '}'; braces--; }
  while (brackets > 0) { s += ']'; brackets--; }
  return s;
}

function validateItem(item: Record<string, unknown>, rawId: number): ClassifiedItem {
  const VALID_TOPICS = ['geopolitics', 'economics', 'science', 'technology', 'culture', 'local'];
  const VALID_DEPTH = ['breaking', 'opinion', 'analysis', 'longform'];
  const VALID_CRED = ['verified', 'likely', 'unconfirmed', 'speculative'];

  const toArray = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.map(String);
    if (typeof v === 'string') return v.split(',').map(s => s.trim());
    return [];
  };

  const toNum = (v: unknown, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
  };

  const topics = toArray(item.topics).filter(t => VALID_TOPICS.includes(t));
  const depthRaw = String(item.depth_type || 'breaking').toLowerCase();
  const credRaw = String(item.credibility || 'unconfirmed').toLowerCase();

  return {
    raw_id: typeof item.raw_id === 'number' ? item.raw_id : rawId,
    topics: topics.length > 0 ? topics : ['geopolitics'],
    regions: toArray(item.regions),
    depth_type: VALID_DEPTH.includes(depthRaw) ? depthRaw : 'breaking',
    cluster_id: String(item.cluster_id || `item_${rawId}`),
    relevance: toNum(item.relevance, 0.5),
    credibility: VALID_CRED.includes(credRaw) ? credRaw : 'unconfirmed',
    credibility_score: toNum(item.credibility_score, 0.5),
    credibility_signals: {
      named_sources: Boolean(item.credibility_signals && (item.credibility_signals as Record<string, unknown>).named_sources),
      multiple_corroboration: Boolean(item.credibility_signals && (item.credibility_signals as Record<string, unknown>).multiple_corroboration),
      speculative_language: Boolean(item.credibility_signals && (item.credibility_signals as Record<string, unknown>).speculative_language),
      opinion_framed_as_fact: Boolean(item.credibility_signals && (item.credibility_signals as Record<string, unknown>).opinion_framed_as_fact),
      official_statement: Boolean(item.credibility_signals && (item.credibility_signals as Record<string, unknown>).official_statement),
    },
    summary: String(item.summary || ''),
    language: String(item.language || 'en'),
  };
}

function parseClassifierResponse(text: string, expectedIds: number[]): ClassifiedItem[] {
  const repaired = repairJson(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(repaired);
  } catch (e) {
    throw new Error(`JSON parse failed after repair (${(e as Error).message}), repaired starts: "${repaired.slice(0, 150)}..."`);
  }

  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const items: ClassifiedItem[] = [];
  for (let i = 0; i < arr.length; i++) {
    const raw = arr[i] as Record<string, unknown>;
    // Use expected raw_id as fallback if model returned wrong/missing id
    const fallbackId = expectedIds[i] ?? 0;
    items.push(validateItem(raw, fallbackId));
  }
  return items;
}

function insertClassifiedItem(item: ClassifiedItem): void {
  const d = getDb();
  d.run(
    `INSERT INTO news_classified (raw_id, topics, regions, depth_type, cluster_id, relevance, credibility, credibility_score, credibility_signals, summary, language)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      item.raw_id,
      JSON.stringify(item.topics),
      JSON.stringify(item.regions),
      item.depth_type,
      item.cluster_id,
      item.relevance,
      item.credibility,
      item.credibility_score,
      JSON.stringify(item.credibility_signals),
      item.summary,
      item.language,
    ],
  );
  d.run('UPDATE news_raw SET classified = 1 WHERE id = ?', [item.raw_id]);
}

async function callOllama(prompt: string): Promise<{
  text: string;
  totalDurationNs?: number;
  evalCount?: number;
  promptEvalCount?: number;
  evalDurationNs?: number;
  promptEvalDurationNs?: number;
}> {
  const url = `${OLLAMA_HOST}/api/generate`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      prompt,
      stream: false,
      options: {
        temperature: 0.3,
        num_predict: 4096,
      },
    }),
    signal: AbortSignal.timeout(180_000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Ollama HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json() as {
    response: string;
    total_duration?: number;
    eval_count?: number;
    prompt_eval_count?: number;
    eval_duration?: number;
    prompt_eval_duration?: number;
  };

  return {
    text: data.response,
    totalDurationNs: data.total_duration,
    evalCount: data.eval_count,
    promptEvalCount: data.prompt_eval_count,
    evalDurationNs: data.eval_duration,
    promptEvalDurationNs: data.prompt_eval_duration,
  };
}

export async function classifyBatch(maxItems = 50): Promise<ClassifyResult> {
  const result: ClassifyResult = { classified: 0, batches: 0, errors: [], timing: [] };

  const unclassified = getUnclassifiedItems(maxItems);
  if (unclassified.length === 0) {
    log('Nothing to classify');
    return result;
  }

  const db = getDb();
  const sourceMap = new Map<string, Source>();
  const stmt = db.prepare('SELECT * FROM news_sources');
  while (stmt.step()) {
    const s = stmt.getAsObject() as unknown as Source;
    sourceMap.set(s.id, s);
  }
  stmt.free();

  const totalBatches = Math.ceil(unclassified.length / BATCH_SIZE);
  log(`Starting: ${unclassified.length} items → ${totalBatches} batches of ${BATCH_SIZE} | model=${MODEL} | host=${OLLAMA_HOST}`);

  for (let i = 0; i < unclassified.length; i += BATCH_SIZE) {
    const batch = unclassified.slice(i, i + BATCH_SIZE);
    result.batches++;
    const batchNum = result.batches;

    try {
      // Fetch full content
      const fetchStart = Date.now();
      const itemsWithContent = await Promise.all(
        batch.map(async (item) => {
          const source = sourceMap.get(item.source_id);
          const content = source
            ? await getItemContent(item, source)
            : item.content || item.title || '';
          return {
            id: item.id,
            source: source?.name || item.source_id,
            bias_hint: source?.bias_hint || null,
            title: item.title || '(no title)',
            content,
            url: item.url,
            published_at: item.published_at,
          };
        }),
      );
      const fetchMs = Date.now() - fetchStart;

      const prompt = buildPrompt(itemsWithContent);
      const titles = itemsWithContent.map(it => it.title.slice(0, 50)).join(' | ');
      log(`Batch ${batchNum}/${totalBatches}: ${batch.length} items, prompt=${fmtKb(prompt.length)}, fetch=${fmtMs(fetchMs)} | ${titles}`);

      const ollamaStart = Date.now();
      const ollamaResult = await callOllama(prompt);
      const ollamaDurationMs = Date.now() - ollamaStart;

      // Build timing from Ollama's native metrics
      const timing: BatchTiming = {
        batch: batchNum,
        items: batch.length,
        durationMs: ollamaDurationMs,
        promptTokens: ollamaResult.promptEvalCount,
        evalTokens: ollamaResult.evalCount,
      };

      // Compute eval tok/s from Ollama's eval_duration (more accurate than wall clock)
      if (ollamaResult.evalCount && ollamaResult.evalDurationNs) {
        timing.tokensPerSec = Math.round(ollamaResult.evalCount / (ollamaResult.evalDurationNs / 1e9));
      }

      result.timing.push(timing);

      const promptTps = ollamaResult.promptEvalCount && ollamaResult.promptEvalDurationNs
        ? Math.round(ollamaResult.promptEvalCount / (ollamaResult.promptEvalDurationNs / 1e9))
        : null;

      log(`Batch ${batchNum}/${totalBatches} done: ${fmtMs(ollamaDurationMs)} wall` +
        ` | prompt: ${timing.promptTokens ?? '?'} tok${promptTps ? ` (${promptTps} t/s)` : ''}` +
        ` | eval: ${timing.evalTokens ?? '?'} tok${timing.tokensPerSec ? ` (${timing.tokensPerSec} t/s)` : ''}` +
        ` | response: ${fmtKb(ollamaResult.text.length)}`);

      // Parse
      const expectedIds = batch.map(it => it.id);
      let classified: ClassifiedItem[];
      try {
        classified = parseClassifierResponse(ollamaResult.text, expectedIds);
      } catch (parseErr) {
        const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        log(`Batch ${batchNum}/${totalBatches} PARSE FAILED: ${msg}`);
        result.errors.push(`Batch ${batchNum} parse error: ${msg}`);
        continue;
      }

      if (classified.length !== batch.length) {
        log(`Batch ${batchNum}/${totalBatches} WARNING: expected ${batch.length} items, got ${classified.length}`);
      }

      // Insert
      let inserted = 0;
      for (const item of classified) {
        try {
          insertClassifiedItem(item);
          result.classified++;
          inserted++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`Insert raw_id=${item.raw_id}: ${msg}`);
          log(`Batch ${batchNum}/${totalBatches} insert error raw_id=${item.raw_id}: ${msg}`);
        }
      }

      log(`Batch ${batchNum}/${totalBatches}: ${inserted}/${classified.length} saved`);
      save();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTimeout = msg.includes('TimeoutError') || msg.includes('abort');
      log(`Batch ${batchNum}/${totalBatches} ${isTimeout ? 'TIMEOUT' : 'ERROR'}: ${msg}`);
      result.errors.push(`Batch ${batchNum}: ${msg}`);
    }
  }

  // Summary
  const totalMs = result.timing.reduce((sum, t) => sum + t.durationMs, 0);
  const totalPromptTok = result.timing.reduce((sum, t) => sum + (t.promptTokens ?? 0), 0);
  const totalEvalTok = result.timing.reduce((sum, t) => sum + (t.evalTokens ?? 0), 0);
  const avgEvalTps = result.timing.filter(t => t.tokensPerSec).length > 0
    ? Math.round(result.timing.filter(t => t.tokensPerSec).reduce((sum, t) => sum + t.tokensPerSec!, 0) / result.timing.filter(t => t.tokensPerSec).length)
    : null;

  log(`Done: ${result.classified}/${unclassified.length} classified, ${result.batches} batches, ${fmtMs(totalMs)} total` +
    ` | ${totalPromptTok} prompt tok + ${totalEvalTok} eval tok` +
    (avgEvalTps ? ` | avg ${avgEvalTps} eval t/s` : '') +
    (result.errors.length > 0 ? ` | ${result.errors.length} errors` : ''));

  return result;
}
