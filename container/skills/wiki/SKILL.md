# Wiki — Personal Knowledge Base

A persistent, compounding knowledge base. You maintain it; the user feeds it sources.

## Directory layout

```
/workspace/group/
  sources/        ← raw inputs (never modify these)
  wiki/           ← your output (you own this entirely)
    index.md      ← catalog of all wiki pages (update on every ingest)
    log.md        ← append-only activity log
    <topic>.md    ← one page per entity, concept, or synthesis
```

## Operations

### Ingest

Triggered when user drops a source (URL, file path, pasted text, image).

1. Read the source fully before doing anything
2. Identify all entities, concepts, and insights worth preserving
3. For each: create a new wiki page OR update an existing one
4. Update cross-references between related pages
5. Update `index.md` — add new pages, update summaries
6. Append to `log.md`: `## [YYYY-MM-DD] ingest | <source title or filename>`
7. Confirm to the user: what was ingested, how many pages touched

**One source at a time.** If the user provides multiple files or a folder, process them one by one — fully finish each before moving to the next. Never batch-read all sources and process them together.

**Sources directory:** Save downloaded/fetched source content to `sources/` with a descriptive filename. This makes re-ingestion possible and keeps provenance clear.

**Source types:**
- URL → use WebFetch or agent-browser for full text; save to `sources/<slug>.md`
- PDF → Read tool handles it; save a copy to `sources/<filename>.pdf` if not already there
- .md / plain text → read directly; optionally copy to `sources/`
- Image → Read tool (Claude can view images); note in wiki what was in the image

### Query

Triggered when user asks a question against the wiki.

1. Read `wiki/index.md` first to find relevant pages
2. Read those pages
3. Synthesize an answer with citations (`[page](wiki/page.md)`)
4. If the answer reveals a gap, offer to create a new wiki page from it
5. Append to `log.md`: `## [YYYY-MM-DD] query | <question summary>`

### Lint

Triggered by user request or scheduled task.

Check for:
- Contradictions between pages
- Stale claims (superseded by newer sources)
- Orphan pages (no inbound links from other pages or index)
- Missing cross-references
- Important concepts without dedicated pages
- Gaps the user should consider filling

Report findings. Offer to fix issues. Append to log.

## Wiki page format

```markdown
# <Title>

**Type:** entity | concept | synthesis | comparison
**Sources:** [source1](../sources/file.md), ...
**Related:** [[Page A]], [[Page B]]
**Last updated:** YYYY-MM-DD

---

<Content>
```

Keep pages focused. One entity or concept per page. Split pages over ~300 lines.

## Index format

Each entry: `[Page title](wiki/page.md) — one-line summary`
Group entries under category headings. Update page count at the bottom.

## Tone

Be dense and factual in wiki pages — these are reference documents, not chat. Save analysis and synthesis for synthesis pages.
