/**
 * News RSS — SQLite schema and helpers
 *
 * Database lives at /workspace/group/news.db (persists across container restarts
 * via the group folder volume mount).
 */

import Database from 'better-sqlite3';

// ── Types ──────────────────────────────────────────────────────────────

export interface Source {
  id: string;
  type: string;
  name: string;
  url: string | null;
  default_topics: string | null;
  default_depth: string | null;
  language: string;
  bias_hint: string | null;
  active: number;
  created_at: string;
}

export interface RawItemInput {
  source_id: string;
  external_id: string | null;
  title: string | null;
  content: string | null;
  url: string | null;
  author: string | null;
  published_at: string | null;
}

export interface RawItem {
  id: number;
  source_id: string;
  external_id: string | null;
  title: string | null;
  content: string | null;
  url: string | null;
  author: string | null;
  published_at: string | null;
  ingested_at: string;
  classified: number;
}

export interface IngestLog {
  source_id: string | null;
  items_fetched: number;
  items_new: number;
  error: string | null;
}

export interface IngestStats {
  total_sources: number;
  active_sources: number;
  total_items: number;
  unclassified: number;
  last_ingest: string | null;
}

// ── Schema ─────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS news_sources (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    url TEXT,
    default_topics TEXT,
    default_depth TEXT,
    language TEXT DEFAULT 'en',
    bias_hint TEXT,
    active BOOLEAN DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS news_raw (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL REFERENCES news_sources(id),
    external_id TEXT,
    title TEXT,
    content TEXT,
    url TEXT,
    author TEXT,
    published_at TEXT,
    ingested_at TEXT DEFAULT (datetime('now')),
    classified BOOLEAN DEFAULT 0,
    UNIQUE(source_id, external_id)
);

CREATE TABLE IF NOT EXISTS news_classified (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raw_id INTEGER NOT NULL REFERENCES news_raw(id),
    topics TEXT,
    regions TEXT,
    depth_type TEXT,
    cluster_id TEXT,
    relevance REAL,
    credibility TEXT,
    credibility_score REAL,
    credibility_signals TEXT,
    summary TEXT,
    language TEXT,
    delivered BOOLEAN DEFAULT 0,
    classified_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS news_ingest_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT,
    started_at TEXT DEFAULT (datetime('now')),
    finished_at TEXT,
    items_fetched INTEGER DEFAULT 0,
    items_new INTEGER DEFAULT 0,
    error TEXT
);
`;

// ── Database singleton ─────────────────────────────────────────────────

let db: Database.Database | null = null;

export function initNewsDb(dbPath: string): Database.Database {
  if (db) return db;
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('News DB not initialized — call initNewsDb() first');
  return db;
}

// ── Helpers ────────────────────────────────────────────────────────────

export function getActiveSources(type?: string): Source[] {
  const d = getDb();
  if (type) {
    return d.prepare('SELECT * FROM news_sources WHERE active = 1 AND type = ?').all(type) as Source[];
  }
  return d.prepare('SELECT * FROM news_sources WHERE active = 1').all() as Source[];
}

export function getAllSources(): Source[] {
  return getDb().prepare('SELECT * FROM news_sources ORDER BY active DESC, name').all() as Source[];
}

export function upsertRawItem(item: RawItemInput): { inserted: boolean; id: number } {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT OR IGNORE INTO news_raw (source_id, external_id, title, content, url, author, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    item.source_id,
    item.external_id,
    item.title,
    item.content,
    item.url,
    item.author,
    item.published_at,
  );
  if (result.changes > 0) {
    return { inserted: true, id: Number(result.lastInsertRowid) };
  }
  // Already existed — look up the existing row
  const existing = d.prepare(
    'SELECT id FROM news_raw WHERE source_id = ? AND external_id = ?',
  ).get(item.source_id, item.external_id) as { id: number } | undefined;
  return { inserted: false, id: existing?.id ?? 0 };
}

export function getUnclassifiedItems(limit = 50): RawItem[] {
  return getDb().prepare(
    'SELECT * FROM news_raw WHERE classified = 0 ORDER BY ingested_at DESC LIMIT ?',
  ).all(limit) as RawItem[];
}

export function getLatestItems(count = 10, sourceId?: string): RawItem[] {
  const d = getDb();
  if (sourceId) {
    return d.prepare(
      'SELECT * FROM news_raw WHERE source_id = ? ORDER BY published_at DESC, ingested_at DESC LIMIT ?',
    ).all(sourceId, count) as RawItem[];
  }
  return d.prepare(
    'SELECT * FROM news_raw ORDER BY published_at DESC, ingested_at DESC LIMIT ?',
  ).all(count) as RawItem[];
}

export function logIngestRun(log: IngestLog): void {
  getDb().prepare(`
    INSERT INTO news_ingest_log (source_id, finished_at, items_fetched, items_new, error)
    VALUES (?, datetime('now'), ?, ?, ?)
  `).run(log.source_id, log.items_fetched, log.items_new, log.error);
}

export function getIngestStats(): IngestStats {
  const d = getDb();
  const sources = d.prepare('SELECT COUNT(*) as c FROM news_sources').get() as { c: number };
  const activeSources = d.prepare('SELECT COUNT(*) as c FROM news_sources WHERE active = 1').get() as { c: number };
  const items = d.prepare('SELECT COUNT(*) as c FROM news_raw').get() as { c: number };
  const unclassified = d.prepare('SELECT COUNT(*) as c FROM news_raw WHERE classified = 0').get() as { c: number };
  const lastIngest = d.prepare(
    'SELECT finished_at FROM news_ingest_log ORDER BY finished_at DESC LIMIT 1',
  ).get() as { finished_at: string } | undefined;

  return {
    total_sources: sources.c,
    active_sources: activeSources.c,
    total_items: items.c,
    unclassified: unclassified.c,
    last_ingest: lastIngest?.finished_at ?? null,
  };
}

export function insertSource(source: {
  id: string;
  type: string;
  name: string;
  url: string;
  default_topics?: string;
  default_depth?: string;
  language?: string;
  bias_hint?: string;
  active?: number;
}): void {
  getDb().prepare(`
    INSERT OR IGNORE INTO news_sources (id, type, name, url, default_topics, default_depth, language, bias_hint, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    source.id,
    source.type,
    source.name,
    source.url,
    source.default_topics ?? null,
    source.default_depth ?? null,
    source.language ?? 'en',
    source.bias_hint ?? null,
    source.active ?? 1,
  );
}

export function deactivateSource(id: string): boolean {
  const result = getDb().prepare('UPDATE news_sources SET active = 0 WHERE id = ?').run(id);
  return result.changes > 0;
}

export function activateSource(id: string): boolean {
  const result = getDb().prepare('UPDATE news_sources SET active = 1 WHERE id = ?').run(id);
  return result.changes > 0;
}
