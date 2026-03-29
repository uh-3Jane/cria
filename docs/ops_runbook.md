# Ops Runbook

This is the small-ops reference for running `cria` on an always-on server.

## Daily Commands

Status:

```bash
docker compose ps
```

Recent logs:

```bash
docker compose logs --tail=100 cria
```

Follow logs live:

```bash
docker compose logs -f cria
```

Restart:

```bash
docker compose restart cria
```

Rebuild + restart:

```bash
./scripts/deploy_compose.sh
```

## Health Signal

Healthy startup should show:

- `bot.ready`

If `bot.ready` is missing, check:

- `.env` values
- Discord token validity
- LLM endpoint availability
- whether `data/cria.db` is writable

## Backup

Create a timestamped DB backup:

```bash
./scripts/backup_db.sh
```

By default this writes into `backups/`.

## Restore

Restore a previous DB:

```bash
./scripts/restore_db.sh /absolute/path/to/cria.db.backup
```

Then restart:

```bash
./scripts/deploy_compose.sh
```

## Upgrade Flow

```bash
git pull
./scripts/backup_db.sh
./scripts/deploy_compose.sh
docker compose logs --tail=50 cria
```

## Things Worth Checking If Behavior Looks Wrong

- Is there more than one `cria` instance running?
- Is the server using the expected `.env`?
- Is the mounted DB the same one you think it is?
- Did the latest deploy rebuild the image or only restart the old container?

## Data Locations

- env: `.env`
- SQLite DB: `data/cria.db`
- backups: `backups/`

## Minimal Monitoring Habit

After each deploy:

1. check `docker compose ps`
2. check `docker compose logs --tail=50 cria`
3. confirm one real Discord interaction
