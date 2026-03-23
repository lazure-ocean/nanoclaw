/**
 * News RSS — SQLite schema and helpers (sql.js — pure WASM, no native deps)
 *
 * Database lives at /workspace/group/news.db (persists across container restarts
 * via the group folder volume mount). Because sql.js is in-memory, we load from
 * disk on init and save after every mutation.
 */

import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import fs from 'fs';

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

let db: SqlJsDatabase | null = null;
let dbPath: string | null = null;

export function save(): void {
  if (!db || !dbPath) return;
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

/** Convert sql.js result rows (array of values) to objects keyed by column names. */
function rowsToObjects<T>(stmt: ReturnType<SqlJsDatabase['prepare']>): T[] {
  const results: T[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    results.push(row as T);
  }
  stmt.free();
  return results;
}

export async function initNewsDb(path: string): Promise<SqlJsDatabase> {
  if (db) return db;
  dbPath = path;

  const SQL = await initSqlJs();

  if (fs.existsSync(path)) {
    const fileBuffer = fs.readFileSync(path);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON');
  db.run(SCHEMA);
  save();
  return db;
}

export function getDb(): SqlJsDatabase {
  if (!db) throw new Error('News DB not initialized — call initNewsDb() first');
  return db;
}

// ── Helpers ────────────────────────────────────────────────────────────

export function getActiveSources(type?: string): Source[] {
  const d = getDb();
  if (type) {
    const stmt = d.prepare('SELECT * FROM news_sources WHERE active = 1 AND type = ?');
    stmt.bind([type]);
    return rowsToObjects<Source>(stmt);
  }
  const stmt = d.prepare('SELECT * FROM news_sources WHERE active = 1');
  return rowsToObjects<Source>(stmt);
}

export function getAllSources(): Source[] {
  const stmt = getDb().prepare('SELECT * FROM news_sources ORDER BY active DESC, name');
  return rowsToObjects<Source>(stmt);
}

export function upsertRawItem(item: RawItemInput): { inserted: boolean; id: number } {
  const d = getDb();
  d.run(
    `INSERT OR IGNORE INTO news_raw (source_id, external_id, title, content, url, author, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [item.source_id, item.external_id, item.title, item.content, item.url, item.author, item.published_at],
  );
  const changes = d.getRowsModified();
  if (changes > 0) {
    const stmt = d.prepare('SELECT last_insert_rowid() as id');
    stmt.step();
    const id = (stmt.getAsObject() as { id: number }).id;
    stmt.free();
    save();
    return { inserted: true, id };
  }
  // Already existed
  const stmt = d.prepare('SELECT id FROM news_raw WHERE source_id = ? AND external_id = ?');
  stmt.bind([item.source_id, item.external_id]);
  let id = 0;
  if (stmt.step()) {
    id = (stmt.getAsObject() as { id: number }).id;
  }
  stmt.free();
  return { inserted: false, id };
}

export function getUnclassifiedItems(limit = 50): RawItem[] {
  const stmt = getDb().prepare('SELECT * FROM news_raw WHERE classified = 0 ORDER BY ingested_at DESC LIMIT ?');
  stmt.bind([limit]);
  return rowsToObjects<RawItem>(stmt);
}

export function getLatestItems(count = 10, sourceId?: string): RawItem[] {
  const d = getDb();
  if (sourceId) {
    const stmt = d.prepare('SELECT * FROM news_raw WHERE source_id = ? ORDER BY published_at DESC, ingested_at DESC LIMIT ?');
    stmt.bind([sourceId, count]);
    return rowsToObjects<RawItem>(stmt);
  }
  const stmt = d.prepare('SELECT * FROM news_raw ORDER BY published_at DESC, ingested_at DESC LIMIT ?');
  stmt.bind([count]);
  return rowsToObjects<RawItem>(stmt);
}

export function logIngestRun(log: IngestLog): void {
  getDb().run(
    `INSERT INTO news_ingest_log (source_id, finished_at, items_fetched, items_new, error)
     VALUES (?, datetime('now'), ?, ?, ?)`,
    [log.source_id, log.items_fetched, log.items_new, log.error],
  );
  save();
}

export function getIngestStats(): IngestStats {
  const d = getDb();

  const scalar = (sql: string): number => {
    const stmt = d.prepare(sql);
    stmt.step();
    const val = (stmt.getAsObject() as { c: number }).c;
    stmt.free();
    return val;
  };

  const total_sources = scalar('SELECT COUNT(*) as c FROM news_sources');
  const active_sources = scalar('SELECT COUNT(*) as c FROM news_sources WHERE active = 1');
  const total_items = scalar('SELECT COUNT(*) as c FROM news_raw');
  const unclassified = scalar('SELECT COUNT(*) as c FROM news_raw WHERE classified = 0');

  let last_ingest: string | null = null;
  const stmt = d.prepare('SELECT finished_at FROM news_ingest_log ORDER BY finished_at DESC LIMIT 1');
  if (stmt.step()) {
    last_ingest = (stmt.getAsObject() as { finished_at: string }).finished_at;
  }
  stmt.free();

  return { total_sources, active_sources, total_items, unclassified, last_ingest };
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
  getDb().run(
    `INSERT OR IGNORE INTO news_sources (id, type, name, url, default_topics, default_depth, language, bias_hint, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      source.id,
      source.type,
      source.name,
      source.url,
      source.default_topics ?? null,
      source.default_depth ?? null,
      source.language ?? 'en',
      source.bias_hint ?? null,
      source.active ?? 1,
    ],
  );
  save();
}

export function deactivateSource(id: string): boolean {
  const d = getDb();
  d.run('UPDATE news_sources SET active = 0 WHERE id = ?', [id]);
  const changed = d.getRowsModified() > 0;
  if (changed) save();
  return changed;
}

export function activateSource(id: string): boolean {
  const d = getDb();
  d.run('UPDATE news_sources SET active = 1 WHERE id = ?', [id]);
  const changed = d.getRowsModified() > 0;
  if (changed) save();
  return changed;
}
