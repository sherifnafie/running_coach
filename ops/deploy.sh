#!/usr/bin/env bash
# Deploy a git ref to the production checkout under $OPENCOACH_HOME and restart the service.
# Usage: ops/deploy.sh <ref>            (ref is fetched from the clone's origin, e.g. a branch, tag or commit)
# First run: OPENCOACH_SOURCE=/path/to/repo ops/deploy.sh <ref>
# Takes a backup first; if install or build fails, the previous commit is restored and restarted.
set -euo pipefail
ref="${1:?usage: deploy.sh <git-ref>}"
base="${OPENCOACH_HOME:-$HOME/opencoach-prod}"
app="$base/app"
service="${OPENCOACH_SERVICE:-opencoach.service}"

if [ ! -d "$app/.git" ]; then
  git clone --no-checkout "${OPENCOACH_SOURCE:?set OPENCOACH_SOURCE to the repository to clone on first deploy}" "$app"
fi
git -C "$app" fetch --quiet --tags origin '+refs/heads/*:refs/remotes/origin/*'
commit=$(git -C "$app" rev-parse --verify --quiet "origin/$ref^{commit}" || git -C "$app" rev-parse --verify "$ref^{commit}")
previous=$(git -C "$app" rev-parse --verify --quiet HEAD || true)
echo "deploying $(git -C "$app" log --oneline -1 "$commit")"

if [ -d "$base/data" ] && [ -n "$previous" ]; then "$app/ops/backup.sh"; fi

build() {
  git -C "$app" checkout --quiet --detach --force "$1"
  (cd "$app" && pnpm install --frozen-lockfile --reporter=silent && pnpm build >/dev/null)
}

systemctl --user stop "$service" || true
if ! build "$commit"; then
  echo "build failed for $commit" >&2
  if [ -n "$previous" ]; then echo "restoring $previous" >&2; build "$previous"; systemctl --user start "$service"; fi
  exit 1
fi
systemctl --user start "$service"
sleep 5
systemctl --user is-active --quiet "$service" || { echo "service failed to start; check: journalctl --user -u $service" >&2; exit 1; }
echo "deployed $commit"
