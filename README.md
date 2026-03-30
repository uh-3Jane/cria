# Cria

Cria is a Discord bot for support triage, learning, and lightweight review in busy community servers. It combines:

- a scan workflow that turns actionable messages into tracked issues
- a mention-based chatbot that can escalate, answer conservatively, and learn from llama follow-ups
- a shared feedback loop that captures chat and scan outcomes into reusable precedent
- a lightweight in-repo review and benchmark lifecycle for measuring improvement over time

## What It Does

- Scans recent Discord messages for actionable support issues
- Caches previously scanned messages so repeat scans are faster
- Tracks open, snoozed, and resolved issues
- Supports category management, recategorization, assignment, and audit logging
- Enriches GitHub-linked issues with PR or commit metadata
- Exposes mention-based chatbot behavior behind an explicit config switch
- Captures llama replies and scan outcomes into a shared learning store
- Lets reviewed precedents influence future chat and scan behavior
- Separates live reviewed precedent memory from eval-only benchmark cases

## Main Commands

- `/scan`
- `/issues`
- `/resolved`
- `/snoozed`
- `/category`
- `/issue category`
- `/config`
- `/admin audit`
- `/cria list`

## Chat and Learning

Cria has two learning layers:

1. Local prompt-conditioning files that can exist on the laptop running the bot.
2. A database-backed learning loop stored in `data/cria.db`.

The database-backed loop is the important live path:

- chat engagements are logged
- llama replies can be captured as knowledge
- scan actions like category changes, resolve/reopen, and assignment feed shared feedback
- shared feedback is written into `learning_feedback`
- reviewed items are surfaced through a review queue
- reviewed precedents can influence future chat and scan behavior

Live behavior is intentionally separated from benchmark evaluation:

- reviewed precedent memory can guide live answers
- benchmark cases are eval-only and are not queried directly for user replies

## Review and Benchmark Workflow

Cria includes a lightweight SQLite-backed review and benchmark lifecycle:

- raw evidence:
  - `knowledge_documents`
  - `learning_feedback`
- review queue:
  - `review_queue`
- benchmark layer:
  - `benchmark_cases`
  - `benchmark_runs`
  - `benchmark_run_results`

Useful local commands:

```bash
bun run review -- queue:list
bun run review -- queue:summary
bun run review -- queue:mark <id> reviewed_good
bun run review -- queue:promote <id> <family> <outcomeType>
bun run review -- benchmark:list active
bun run benchmark:run
bun run benchmark:summary
```

This is meant to support:

- reviewing raw production traces
- promoting representative cases into a benchmark set
- tracking corrected vs reinforced patterns
- measuring whether Cria is getting better over time

## Setup

1. Install dependencies:

```bash
bun install
```

2. Copy the example env file and fill in real values:

```bash
cp .env.example .env
```

3. Start the bot:

```bash
bun run src/index.ts
```

## Environment

Important variables:

- `DISCORD_TOKEN`
- `APPLICATION_ID`
- `LLM_API_BASE_URL`
- `LLM_API_KEY`
- `LLM_MODEL`
- `DATABASE_PATH`

Optional variables:

- `GUILD_ID` for guild-specific slash command registration
- `GITHUB_TOKEN` for higher-rate GitHub enrichment

Never commit `.env`. This repo ignores it by default.

## Development Notes

- Runtime data lives under `data/`
- The bot uses Bun + TypeScript
- `docker-compose.yml` includes `restart: unless-stopped`
- Chatbot behavior is configurable and off by default until enabled in Discord
- Review and benchmark tooling is local/in-repo and SQLite-backed

## Verification

Typecheck:

```bash
bun x tsc --noEmit
```
