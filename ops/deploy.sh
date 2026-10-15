#!/usr/bin/env bash
# Deploy a git ref to the production checkout under $OPENCOACH_HOME and restart the service.
# Usage: ops/deploy.sh <ref>            (ref is fetched from the clone's origin, e.g. a branch, tag or commit)
# First run: OPENCOACH_SOURCE=/path/to/repo ops/deploy.sh <ref>
# Takes a backup first (series "predeploy"). If install or build fails, or the new version doesn't come up and answer
# HTTP, the previous commit is rebuilt and restarted. Database migrations only go forward: a rollback after a migration
# ran needs the pre-deploy backup.
set -euo pipefail
ref="${1:?usage: deploy.sh <git-ref>}"
base="${OPENCOACH_HOME:-$HOME/opencoach-prod}"
app="$base/app"
service="${OPENCOACH_SERVICE:-opencoach.service}"
port=$(sed -n 's/^PORT=//p' "$base/opencoach.env" 2>/dev/null | tail -n 1)
health="http://127.0.0.1:${port:-8080}/v1/me"   # any HTTP answer (401 when signed out) means the server is serving

if [ ! -d "$app/.git" ]; then
  git clone --no-checkout "${OPENCOACH_SOURCE:?set OPENCOACH_SOURCE to the repository to clone on first deploy}" "$app"
fi
git -C "$app" fetch --quiet --tags origin '+refs/heads/*:refs/remotes/origin/*'
commit=$(git -C "$app" rev-parse --verify --quiet "origin/$ref^{commit}" || git -C "$app" rev-parse --verify "$ref^{commit}")
previous=$(git -C "$app" rev-parse --verify --quiet HEAD || true)
echo "deploying $(git -C "$app" log --oneline -1 "$commit")"

if [ -d "$base/data" ] && [ -n "$previous" ]; then
  OPENCOACH_BACKUP_LABEL=predeploy OPENCOACH_BACKUP_KEEP="${OPENCOACH_PREDEPLOY_KEEP:-10}" "$app/ops/backup.sh"
fi

build() {
  git -C "$app" checkout --quiet --detach --force "$1" || return 1
  (cd "$app" && pnpm install --frozen-lockfile --reporter=silent && pnpm build >/dev/null)
}

# Up means: systemd reports it active and it answers HTTP within a minute.
healthy() {
  for _ in $(seq 1 30); do
    if systemctl --user is-active --quiet "$service" && curl -s -o /dev/null -m 2 "$health"; then return 0; fi
    sleep 2
  done
  return 1
}

rollback() {
  echo "$1" >&2
  if [ -z "$previous" ]; then exit 1; fi
  echo "restoring $previous" >&2
  systemctl --user stop "$service" || true
  build "$previous"
  systemctl --user start "$service"
  healthy || echo "the previous version did not come back up either; check: journalctl --user -u $service" >&2
  exit 1
}

systemctl --user stop "$service" || true
build "$commit" || rollback "build failed for $commit"
systemctl --user start "$service"
healthy || rollback "the new version did not come up (no HTTP answer on $health); check: journalctl --user -u $service"
echo "deployed $commit"
