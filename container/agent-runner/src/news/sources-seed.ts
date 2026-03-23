/**
 * News RSS — Default source definitions
 *
 * Seeds the sources table on first run. Skips if sources already exist.
 * Feed URLs may go stale — verify with `curl -s <url> | head -20` at setup time.
 */

import { getDb, insertSource } from './db.js';

interface SourceSeed {
  id: string;
  type: string;
  name: string;
  url: string;
  default_topics: string;
  default_depth: string;
  language: string;
  bias_hint?: string;
  active?: number;
}

const RSS_SOURCES: SourceSeed[] = [
  {
    id: 'rss:reuters-world',
    type: 'rss',
    name: 'Reuters World',
    url: 'https://openrss.org/feed/www.reuters.com',
    default_topics: JSON.stringify(['geopolitics', 'economics']),
    default_depth: 'breaking',
    language: 'en',
  },
  {
    id: 'rss:ap-news',
    type: 'rss',
    name: 'AP News',
    url: 'https://feedx.net/rss/ap.xml',
    default_topics: JSON.stringify(['geopolitics']),
    default_depth: 'breaking',
    language: 'en',
  },
  {
    id: 'rss:bbc-world',
    type: 'rss',
    name: 'BBC World',
    url: 'https://feeds.bbci.co.uk/news/world/rss.xml',
    default_topics: JSON.stringify(['geopolitics']),
    default_depth: 'breaking',
    language: 'en',
  },
  {
    id: 'rss:meduza',
    type: 'rss',
    name: 'Meduza',
    url: 'https://meduza.io/rss2/all',
    default_topics: JSON.stringify(['Russia', 'geopolitics', 'culture']),
    default_depth: 'analysis',
    language: 'ru',
  },
  {
    id: 'rss:thebell',
    type: 'rss',
    name: 'The Bell',
    url: 'https://thebell.io/feed',
    default_topics: JSON.stringify(['Russia', 'economics']),
    default_depth: 'analysis',
    language: 'ru',
  },
  {
    id: 'rss:economist',
    type: 'rss',
    name: 'The Economist',
    url: 'https://www.economist.com/international/rss.xml',
    default_topics: JSON.stringify(['economics', 'geopolitics']),
    default_depth: 'longform',
    language: 'en',
  },
  {
    id: 'rss:carnegie',
    type: 'rss',
    name: 'Carnegie Endowment',
    url: 'https://news.google.com/rss/search?q=site:carnegieendowment.org+when:30d&ceid=US:en&hl=en-US&gl=US',
    default_topics: JSON.stringify(['geopolitics', 'Russia']),
    default_depth: 'longform',
    language: 'en',
  },
  {
    id: 'rss:foreign-affairs',
    type: 'rss',
    name: 'Foreign Affairs',
    url: 'https://www.foreignaffairs.com/rss.xml',
    default_topics: JSON.stringify(['geopolitics']),
    default_depth: 'longform',
    language: 'en',
    active: 0,
  },
];

export function seedSources(): { seeded: number; skipped: number } {
  const d = getDb();
  const stmt = d.prepare('SELECT COUNT(*) as c FROM news_sources');
  stmt.step();
  const count = (stmt.getAsObject() as { c: number }).c;
  stmt.free();

  if (count > 0) {
    return { seeded: 0, skipped: count };
  }

  let seeded = 0;
  for (const source of RSS_SOURCES) {
    insertSource({
      id: source.id,
      type: source.type,
      name: source.name,
      url: source.url,
      default_topics: source.default_topics,
      default_depth: source.default_depth,
      language: source.language,
      bias_hint: source.bias_hint,
      active: source.active,
    });
    seeded++;
  }

  return { seeded, skipped: 0 };
}
