#!/usr/bin/env bash
# Consistent snapshot of the OpenCoach data directory while the server runs.
# SQLite files go through the online backup API and are integrity-checked; everything else is copied.
# OPENCOACH_BACKUP_LABEL names the series (default "nightly"; deploy.sh uses "predeploy"). Each series keeps its own
# newest $OPENCOACH_BACKUP_KEEP archives, so a day of deploys can't push the nightly history out.
set -euo pipefail
umask 077
base="${OPENCOACH_HOME:-$HOME/opencoach-prod}"
data="${OPENCOACH_DATA_DIR:-$base/data}"
dest="${OPENCOACH_BACKUP_DIR:-$base/backups}"
keep="${OPENCOACH_BACKUP_KEEP:-14}"
label="${OPENCOACH_BACKUP_LABEL:-nightly}"
[[ "$label" =~ ^[a-z0-9-]+$ ]] || { echo "invalid backup label: $label" >&2; exit 1; }
[[ "$keep" =~ ^[1-9][0-9]*$ ]] || { echo "OPENCOACH_BACKUP_KEEP must be a positive integer" >&2; exit 1; }
[ -d "$data" ] || { echo "data directory not found: $data" >&2; exit 1; }
command -v sqlite3 >/dev/null || { echo "sqlite3 is required for consistent database copies" >&2; exit 1; }
mkdir -p "$dest"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
archive="$dest/opencoach-$label-$stamp.tar.gz"
work=$(mktemp -d "$dest/.tmp-$stamp.XXXXXX")
trap 'rm -rf "$work" "$archive.part"' EXIT

rsync -a --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' --exclude='*.db-journal' "$data/" "$work/data/"
while IFS= read -r -d '' db; do
  mkdir -p "$work/data/$(dirname "$db")"
  sqlite3 "$data/$db" ".backup '$work/data/$db'"
  check=$(sqlite3 "$work/data/$db" 'PRAGMA quick_check;')
  [ "$check" = "ok" ] || { echo "backup of $db failed its integrity check: $check" >&2; exit 1; }
done < <(cd "$data" && find . -type f -name '*.db' -print0)

tar -C "$work" -czf "$archive.part" data
gzip -t "$archive.part"
mv "$archive.part" "$archive"
echo "backup written: $archive"

# Retention per series. Archives from before labels existed (opencoach-<stamp>.tar.gz) count as nightly.
pattern="opencoach-$label-*.tar.gz"
legacy=()
[ "$label" = nightly ] && legacy=(-o -name 'opencoach-[0-9]*.tar.gz')
find "$dest" -maxdepth 1 \( -name "$pattern" "${legacy[@]}" \) -printf '%f\n' \
  | sed -E 's/^opencoach-([a-z0-9-]+-)?([0-9]{8}T[0-9]{6}Z)\.tar\.gz$/\2 &/' | sort -r | tail -n +"$((keep + 1))" | cut -d' ' -f2 \
  | while IFS= read -r old; do rm -f -- "$dest/$old"; done
