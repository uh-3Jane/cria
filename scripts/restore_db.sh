#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 /absolute/path/to/backup.db"
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DB="$1"
TARGET_DB="$ROOT_DIR/data/cria.db"

if [[ ! -f "$SOURCE_DB" ]]; then
  echo "Backup file not found: $SOURCE_DB"
  exit 1
fi

mkdir -p "$ROOT_DIR/data"
cp "$SOURCE_DB" "$TARGET_DB"
echo "Restored database to $TARGET_DB"
