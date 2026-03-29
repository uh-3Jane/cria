#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_PATH="$ROOT_DIR/data/cria.db"
BACKUP_DIR="$ROOT_DIR/backups"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"

if [[ ! -f "$DB_PATH" ]]; then
  echo "Database not found at $DB_PATH"
  exit 1
fi

TARGET="$BACKUP_DIR/cria-$STAMP.db"
cp "$DB_PATH" "$TARGET"
echo "Backup written to $TARGET"
