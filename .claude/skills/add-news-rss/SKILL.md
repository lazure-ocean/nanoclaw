---
name: add-news-rss
description: Add a news intelligence system with RSS feed ingestion to NanoClaw. Creates SQLite schema for sources and items, RSS poller with 8 seeded feeds, and MCP tools for status, polling, browsing, and source management. Use when the user wants news feed monitoring, RSS ingestion, or the news intelligence foundation.
---

# Add News RSS Ingestion

This skill adds the foundation of a news intelligence system to NanoClaw:
1. SQLite schema for sources, raw news items, and classified items
2. RSS feed poller with scheduled and manual execution
3. Eight seeded RSS sources (Reuters, AP, BBC, Meduza, The Bell, Economist, Carnegie, Foreign Affairs)
4. MCP tools for status, polling, browsing items, and managing sources

Later skills (add-news-classify, add-news-digest) will build on this foundation.

## Phase 1: Pre-flight

### Check if already applied

Check if `container/agent-runner/src/news/db.ts` exists. If it does, skip to Phase 3 (Verify). The code changes are already in place.

## Phase 2: Apply Code Changes

### Merge the skill branch

```bash
git fetch origin skill/news-rss
git merge origin/skill/news-rss || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `container/agent-runner/src/news/` — db.ts, sources-seed.ts, rss-poller.ts, tools.ts
- `container/agent-runner/src/ipc-mcp-stdio.ts` — imports and registers news MCP tools
- `container/agent-runner/package.json` — adds `better-sqlite3` and `rss-parser`
- `container/Dockerfile` — adds build tools (python3, make, g++) for native compilation
- `container/skills/news-rss/SKILL.md` — container skill for agent awareness

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate code changes

```bash
cd container/agent-runner && npm install && npx tsc --noEmit
```

Build must be clean before proceeding.

### Rebuild the container

```bash
./container/build.sh
```

## Phase 3: Verify

### Verify RSS feed URLs

Many outlets change or remove RSS feeds over time. Test each seeded feed:

```bash
# Quick test of all seeded feeds
for url in \
  "https://feeds.bbci.co.uk/news/world/rss.xml" \
  "https://meduza.io/rss2/all" \
  "https://www.economist.com/rss" \
  "https://carnegieendowment.org/rss/solr/?lang=en" \
  "https://www.foreignaffairs.com/rss.xml" \
  "https://thebell.io/feed" \
  "https://rsshub.app/apnews/topics/apf-topnews" \
  "https://www.rss.app/feeds/v1.1/_Qd3B0mR3H2UkNcP.json"; do
  echo "--- $url ---"
  curl -sf "$url" | head -5 || echo "FAILED"
  echo
done
```

If a feed fails:
1. Check the outlet's website for a current RSS/Atom link
2. Try RSSHub (https://docs.rsshub.app/) as a proxy
3. Flag the source for manual discovery — the user can update it later via the `news_add_source` tool

Report any broken feeds to the user. Don't block setup — broken feeds are logged per-source and don't affect other feeds.

### Test the system

Ask the user to send a message to the agent:
- "news status" — should return zeros (no items yet)
- "poll news" — should fetch items from working feeds
- "latest news" — should show recent items

### Set up scheduled polling (optional)

Ask the user if they want automatic polling. If yes, the agent can set it up:
- "Set up news polling every 2 hours" — agent will use `schedule_task`

Default recommendation: every 2 hours (`0 */2 * * *`).

## Architecture Notes

### File structure on the branch

```
container/agent-runner/src/news/
├── db.ts              # SQLite schema, init, query helpers
├── sources-seed.ts    # 8 default RSS source definitions
├── rss-poller.ts      # Fetch + parse + upsert logic
└── tools.ts           # MCP tool registration (6 tools)
container/skills/news-rss/
└── SKILL.md           # Container skill — agent instructions
```

### MCP tools added

| Tool | Purpose |
|------|---------|
| `news_status` | Ingestion stats |
| `news_poll_now` | Manual feed poll |
| `news_latest` | Browse recent items |
| `news_sources` | List all sources |
| `news_add_source` | Add a new RSS source |
| `news_toggle_source` | Activate/deactivate a source |

### Database

SQLite at `/workspace/group/news.db` (persists via group folder mount). Tables:
- `news_sources` — feed registry
- `news_raw` — ingested items (deduped by source_id + external_id)
- `news_classified` — classified items (populated by future classify skill)
- `news_ingest_log` — poll run history

### Future skills

- **add-news-classify**: Claude/Haiku classification of raw items into topics, regions, credibility
- **add-news-digest**: Scheduled digest delivery (morning brief, evening digest, weekly longform)
- **add-news-telegram**: Telegram channel polling into the same news_raw table
