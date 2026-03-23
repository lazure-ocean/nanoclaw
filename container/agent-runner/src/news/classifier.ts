/**
 * News Classify — Batch classification using Claude Haiku
 *
 * Reads unclassified items from news_raw, sends them in batches to Haiku,
 * writes results to news_classified, and marks raw items as classified.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  getDb,
  getUnclassifiedItems,
  getActiveSources,
  save,
  type Source,
} from './db.js';
import { getItemContent } from './fetch-full.js';

const BATCH_SIZE = 15;
const MODEL = 'claude-haiku-4-5-20251001';

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
}

function buildPrompt(items: Array<{ id: number; source: string; bias_hint: string | null; title: string; content: string; url: string | null; published_at: string | null }>): string {
  const itemsBlock = items.map((item, i) => `
<item index="${i}" raw_id="${item.id}" source="${item.source}" bias_hint="${item.bias_hint || 'none'}">
  <title>${item.title}</title>
  <published>${item.published_at || 'unknown'}</published>
  <url>${item.url || ''}</url>
  <content>${item.content}</content>
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
- Return ONLY the JSON array, no other text.`;
}

function parseClassifierResponse(text: string): ClassifiedItem[] {
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('No JSON array found in classifier response');
  return JSON.parse(jsonMatch[0]) as ClassifiedItem[];
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

export async function classifyBatch(maxItems = 50): Promise<ClassifyResult> {
  const result: ClassifyResult = { classified: 0, batches: 0, errors: [] };

  const unclassified = getUnclassifiedItems(maxItems);
  if (unclassified.length === 0) return result;

  // Build source lookup (including inactive sources for already-ingested items)
  const db = getDb();
  const sourceMap = new Map<string, Source>();
  const stmt = db.prepare('SELECT * FROM news_sources');
  while (stmt.step()) {
    const s = stmt.getAsObject() as unknown as Source;
    sourceMap.set(s.id, s);
  }
  stmt.free();

  const client = new Anthropic();

  for (let i = 0; i < unclassified.length; i += BATCH_SIZE) {
    const batch = unclassified.slice(i, i + BATCH_SIZE);
    result.batches++;

    try {
      // Fetch full content for analysis/longform items
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

      const prompt = buildPrompt(itemsWithContent);

      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      });

      const responseText = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');

      const classified = parseClassifierResponse(responseText);

      for (const item of classified) {
        try {
          insertClassifiedItem(item);
          result.classified++;
        } catch (err) {
          result.errors.push(`Insert error for raw_id ${item.raw_id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Persist to disk after each batch
      save();
    } catch (err) {
      result.errors.push(`Batch ${result.batches} error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}
