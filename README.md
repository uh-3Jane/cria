# Cria

Cria is a Discord bot for support triage in busy community servers. It scans recent channel activity, turns concrete support requests into tracked issues, enriches GitHub-linked follow-ups, and exposes lightweight issue-management commands inside Discord.

## What It Does

- Scans recent Discord messages for actionable support issues
- Caches previously scanned messages so repeat scans are faster
- Tracks open, snoozed, and resolved issues
- Supports category management and issue recategorization
- Enriches GitHub-linked issues with PR or commit metadata
- Exposes mention-based chatbot behavior behind an explicit config switch

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

## Server Deployment

For moving `cria` onto the DefiLlama main server:

- migration checklist: [defillama_server_migration.md](docs/defillama_server_migration.md)
- ops runbook: [ops_runbook.md](docs/ops_runbook.md)

Helper scripts:

```bash
./scripts/deploy_compose.sh
./scripts/backup_db.sh
./scripts/restore_db.sh /absolute/path/to/backup.db
```

## Verification

Typecheck:

```bash
bun x tsc --noEmit
```
