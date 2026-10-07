#!/usr/bin/env bash
# Consistent snapshot of the OpenCoach data directory while the server runs.
# SQLite files go through the online backup API; everything else is copied. Keeps the newest $OPENCOACH_BACKUP_KEEP archives.
set -euo pipefail
umask 077
base="${OPENCOACH_HOME:-$HOME/opencoach-prod}"
data="${OPENCOACH_DATA_DIR:-$base/data}"
dest="${OPENCOACH_BACKUP_DIR:-$base/backups}"
keep="${OPENCOACH_BACKUP_KEEP:-14}"
[ -d "$data" ] || { echo "data directory not found: $data" >&2; exit 1; }
mkdir -p "$dest"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
work=$(mktemp -d "$dest/.tmp-$stamp.XXXXXX")
trap 'rm -rf "$work"' EXIT

rsync -a --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' --exclude='*.db-journal' "$data/" "$work/data/"
(cd "$data" && find . -type f -name '*.db' -print0) | while IFS= read -r -d '' db; do
  mkdir -p "$work/data/$(dirname "$db")"
  sqlite3 "$data/$db" ".backup '$work/data/$db'"
done

archive="$dest/opencoach-$stamp.tar.gz"
tar -C "$work" -czf "$archive.part" data
mv "$archive.part" "$archive"
echo "backup written: $archive"

find "$dest" -maxdepth 1 -name 'opencoach-*.tar.gz' -printf '%f\n' | sort -r | tail -n +"$((keep + 1))" | while IFS= read -r old; do
  rm -f -- "$dest/$old"
done
