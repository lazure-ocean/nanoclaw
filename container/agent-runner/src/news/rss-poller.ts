/**
 * News RSS — Feed poller
 *
 * Fetches all active RSS sources, parses items, and upserts into the database.
 * Sequential polling with 15s timeout per feed. One failing feed does not stop others.
 */

import Parser from 'rss-parser';
import { getActiveSources, upsertRawItem, logIngestRun } from './db.js';

const parser = new Parser({
  timeout: 15000,
  headers: {
    'User-Agent': 'NanoClaw-NewsBot/1.0',
  },
});

export interface PollResult {
  fetched: number;
  newItems: number;
  errors: Array<{ source: string; error: string }>;
  perSource: Array<{ source: string; fetched: number; new: number }>;
}

export async function pollRssFeeds(): Promise<PollResult> {
  const sources = getActiveSources('rss');
  const result: PollResult = { fetched: 0, newItems: 0, errors: [], perSource: [] };

  for (const source of sources) {
    if (!source.url) continue;

    const logEntry = {
      source_id: source.id,
      items_fetched: 0,
      items_new: 0,
      error: null as string | null,
    };

    try {
      const feed = await parser.parseURL(source.url);

      for (const item of feed.items) {
        logEntry.items_fetched++;

        const { inserted } = upsertRawItem({
          source_id: source.id,
          external_id: item.guid || item.link || item.title || null,
          title: item.title?.trim() || null,
          content: item.contentSnippet || item.content || item.summary || null,
          url: item.link || null,
          author: item.creator || item.author || null,
          published_at: item.isoDate || item.pubDate || null,
        });

        if (inserted) logEntry.items_new++;
      }

      result.fetched += logEntry.items_fetched;
      result.newItems += logEntry.items_new;
      result.perSource.push({
        source: source.name,
        fetched: logEntry.items_fetched,
        new: logEntry.items_new,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logEntry.error = message;
      result.errors.push({ source: source.name, error: message });
    }

    logIngestRun(logEntry);
  }

  return result;
}
