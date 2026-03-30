# DefiLlama Server Migration

This guide is the production handoff checklist for moving `cria` from a laptop-hosted Docker setup to the DefiLlama main server.

## Goal

Run exactly one always-on `cria` instance on the main server, preserve the current learning/scan database, and make restart/backup/debugging straightforward.

## What Must Move

- Repo code
- `.env` values
- SQLite database at `data/cria.db`
- Discord app permissions and channel config already used by the bot

## Recommended Runtime

Use Docker Compose on the main server and keep the current mounted database layout:

- container app path: `/app`
- persistent DB path in container: `/app/data/cria.db`
- host-side bind mount: `./data:/app/data`

That matches the current [docker-compose.yml](../docker-compose.yml) behavior and keeps migration simple.

## Pre-Cutover Checklist

1. Confirm the target server has:
   - Docker
   - Docker Compose
   - Git access to the repo
2. Confirm you have production values for:
   - `DISCORD_TOKEN`
   - `APPLICATION_ID`
   - `LLM_API_BASE_URL`
   - `LLM_API_KEY`
   - `LLM_MODEL`
   - optional `GITHUB_TOKEN`
3. Decide whether to keep `GUILD_ID` pinned or leave it blank for broader registration behavior.
4. Copy the current SQLite DB if you want to preserve learning and issue history:
   - `data/cria.db`

## One-Time Server Setup

```bash
git clone <repo-url> cria
cd cria
cp .env.example .env
mkdir -p data backups
```

Fill in `.env` with the real production values.

If preserving the current learning/history state, copy the DB into place:

```bash
scp /path/to/local/cria.db <server>:/path/to/cria/data/cria.db
```

## First Start

Use the helper script:

```bash
./scripts/deploy_compose.sh
```

Or run it manually:

```bash
docker compose up -d --build
docker compose logs --tail=50 cria
```

You want to see:

- `bot.ready`

## Cutover Checklist

1. Stop the laptop-hosted instance first.
2. Make sure only one `cria` process will be connected to Discord.
3. Start the server instance.
4. Verify:
   - bot appears online in Discord
   - one direct mention works
   - one `/scan` run works
   - DB writes are happening
5. Only after that, treat the server instance as primary.

## Post-Cutover Smoke Checks

Run:

```bash
docker compose ps
docker compose logs --tail=100 cria
```

Then verify in Discord:

- mention reply path
- scan command path
- issue assign/category/resolve path
- one known learning-backed question if available

## Rollback

If the server deploy is bad:

1. `docker compose down`
2. restore the previous `data/cria.db` backup if needed
3. restart the last known-good version

Use:

```bash
./scripts/restore_db.sh /path/to/backup.db
./scripts/deploy_compose.sh
```
