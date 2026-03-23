/**
 * News Classify — Full article fetcher
 *
 * Hybrid strategy: breaking items use RSS content as-is,
 * analysis/longform/opinion items get full article extraction.
 * Uses @mozilla/readability + jsdom for clean text extraction.
 */

import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import type { RawItem, Source } from './db.js';

const FETCH_TIMEOUT = 10_000;
const MAX_WORDS = 2000;
const RATE_LIMIT_MS = 1000;

let lastFetchTime = 0;

async function rateLimitedFetch(url: string): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastFetchTime;
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise((r) => setTimeout(r, RATE_LIMIT_MS - elapsed));
  }
  lastFetchTime = Date.now();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NanoClaw-NewsBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

function extractWithReadability(html: string, url: string): string | null {
  try {
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    return article?.textContent?.trim() || null;
  } catch {
    return null;
  }
}

function stripHtmlFallback(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateToWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(' ') + '...';
}

/**
 * Get the best available text content for a news item.
 * For breaking items, returns RSS content. For analysis/longform/opinion,
 * attempts full article fetch with readability extraction.
 */
export async function getItemContent(
  item: RawItem,
  source: Source,
): Promise<string> {
  const rssContent = item.content || item.title || '';
  const depth = source.default_depth;

  // Breaking items: RSS content is sufficient
  if (depth === 'breaking' || !item.url) {
    return truncateToWords(rssContent, MAX_WORDS);
  }

  // Analysis/longform/opinion: try full article fetch
  try {
    const response = await rateLimitedFetch(item.url);
    if (!response.ok) {
      return truncateToWords(rssContent, MAX_WORDS);
    }

    const html = await response.text();
    const fullText = extractWithReadability(html, item.url)
      || stripHtmlFallback(html);

    if (fullText && fullText.length > rssContent.length) {
      return truncateToWords(fullText, MAX_WORDS);
    }
  } catch {
    // Fetch failed (timeout, paywall, etc.) — use RSS content
  }

  return truncateToWords(rssContent, MAX_WORDS);
}
