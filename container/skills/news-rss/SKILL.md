---
name: news-rss
description: News intelligence system with RSS feed ingestion. Provides MCP tools to poll feeds, check status, browse latest items, and manage sources. Use when the user asks about news, feeds, headlines, or says "news status", "poll news", "latest news", "news sources", or "add feed".
---

# News RSS Intelligence

You have access to a news RSS ingestion system via MCP tools. The system stores items in a local SQLite database at `/workspace/group/news.db`.

## Available tools

| Tool | Purpose |
|------|---------|
| `mcp__nanoclaw__news_status` | Ingestion stats: source count, items, last poll time |
| `mcp__nanoclaw__news_poll_now` | Manually trigger an RSS poll of all active sources |
| `mcp__nanoclaw__news_latest` | Get recent items (params: `count`, `source_id`) |
| `mcp__nanoclaw__news_sources` | List all configured sources with active/inactive status |
| `mcp__nanoclaw__news_add_source` | Add a new RSS source (params: `id`, `name`, `url`, `topics`, `depth`, `language`) |
| `mcp__nanoclaw__news_toggle_source` | Activate or deactivate a source (params: `id`, `active`) |

## When to use

- "news status" / "how's the news system" → `news_status`
- "poll news" / "fetch feeds" / "check news" → `news_poll_now`
- "latest news" / "what's new" / "headlines" → `news_latest`
- "show feeds" / "list sources" → `news_sources`
- "add feed X" → `news_add_source`
- "disable/enable source X" → `news_toggle_source`

## Formatting

When showing news items to the user:
- Use the language the user asked in
- Bold the title, include the source name and date
- Include the URL as a link
- For multiple items, use a numbered list
- Keep it concise — title + source + date + link per item

## Scheduled polling

To set up automatic polling, use the `schedule_task` tool:
```
schedule_task(
  prompt: "Poll RSS news feeds. Use the news_poll_now tool. Only send a message if there are new items — summarize the count per source.",
  schedule_type: "cron",
  schedule_value: "0 */2 * * *",
  context_mode: "isolated"
)
```

## Default sources

Eight RSS feeds are seeded on first use: Reuters World, AP News, BBC World, Meduza, The Bell, The Economist, Carnegie Endowment, and Foreign Affairs (inactive by default).
