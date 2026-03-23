---
name: news-rss
description: News intelligence system with RSS feed ingestion and classification. Provides MCP tools to poll feeds, classify items with AI, search by topic/region/credibility, and view story clusters. Use when the user asks about news, feeds, headlines, classification, or says "news status", "poll news", "classify news", "search news", "news clusters", or "add feed".
---

# News Intelligence System

You have access to a news RSS ingestion and classification system via MCP tools. The system stores items in a local SQLite database at `/workspace/group/news.db`.

## Available tools

### Ingestion
| Tool | Purpose |
|------|---------|
| `mcp__nanoclaw__news_status` | Ingestion stats: source count, items, last poll time |
| `mcp__nanoclaw__news_poll_now` | Manually trigger an RSS poll of all active sources |
| `mcp__nanoclaw__news_latest` | Get recent raw items (params: `count`, `source_id`) |
| `mcp__nanoclaw__news_sources` | List all configured sources with active/inactive status |
| `mcp__nanoclaw__news_add_source` | Add a new RSS source |
| `mcp__nanoclaw__news_toggle_source` | Activate or deactivate a source |

### Classification
| Tool | Purpose |
|------|---------|
| `mcp__nanoclaw__news_classify_now` | Classify unclassified items using Claude Haiku (params: `max_items`) |
| `mcp__nanoclaw__news_search` | Search classified items by topic, region, depth, credibility, relevance, time range |
| `mcp__nanoclaw__news_clusters` | Show story clusters with source counts and credibility |

## When to use

- "news status" → `news_status`
- "poll news" / "fetch feeds" → `news_poll_now`
- "latest news" / "headlines" → `news_latest`
- "classify news" / "run classifier" → `news_classify_now`
- "search news about X" / "news on topic Y" → `news_search`
- "story clusters" / "what stories are trending" → `news_clusters`
- "show feeds" / "list sources" → `news_sources`

## Typical workflow

1. `news_poll_now` — fetch latest items from RSS feeds
2. `news_classify_now` — classify new items with AI
3. `news_search` or `news_clusters` — query the classified data

## Formatting

When showing news items to the user:
- Use the language the user asked in
- Bold the title, include the source name and date
- Include the URL as a link
- For classified items, include the summary, credibility, and relevance
- For clusters, group items by story and show source count

## Default sources

Eight RSS feeds are seeded on first use: Reuters World, AP News, BBC World, Meduza, The Bell, The Economist, Carnegie Endowment, and Foreign Affairs (inactive by default).
