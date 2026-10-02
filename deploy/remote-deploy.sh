#!/usr/bin/env bash
# Runs ON the production server. Builds a release, migrates DB, flips `current`, reloads PM2.
# Live API keeps serving the previous release until the flip.
set -euo pipefail

DEPLOY_PATH="${DEPLOY_PATH:?DEPLOY_PATH required}"
RELEASE_SHA="${RELEASE_SHA:?RELEASE_SHA required}"
HEALTH_URL="${HEALTH_URL:-https://api.vbizme.com/api/v1/health}"
SKIP_MIGRATE="${SKIP_MIGRATE:-false}"
RELEASE_DIR="${DEPLOY_PATH}/releases/${RELEASE_SHA}"
SHARED_ENV="${DEPLOY_PATH}/shared/.env"
KEEP_RELEASES="${KEEP_RELEASES:-5}"

cd "$RELEASE_DIR"

if [[ ! -f "$SHARED_ENV" ]]; then
  echo "ERROR: missing ${SHARED_ENV}"
  echo "Create production env once:  nano ${SHARED_ENV}"
  exit 1
fi

ln -sfn "$SHARED_ENV" "$RELEASE_DIR/.env"

echo "==> Installing dependencies in release ${RELEASE_SHA} (live API untouched)"
yarn install --frozen-lockfile
yarn prisma generate

echo "==> Compiling TypeScript in release ${RELEASE_SHA}"
yarn build

if [[ "$SKIP_MIGRATE" != "true" ]]; then
  echo "==> Running prisma migrate deploy (before traffic switch)"
  # Uses shared .env DATABASE_URL — migrations are additive; keep backups.
  yarn migrate:deploy
else
  echo "==> SKIP_MIGRATE=true — skipping prisma migrate deploy"
fi

echo "==> Atomic symlink flip → current"
ln -sfn "$RELEASE_DIR" "${DEPLOY_PATH}/current"
cp -f "${RELEASE_DIR}/ecosystem.config.cjs" "${DEPLOY_PATH}/ecosystem.config.cjs"

echo "==> PM2 reload (graceful)"
cd "$DEPLOY_PATH"
# Drop the short-lived name if a previous broken deploy created it.
pm2 delete vbiz-api >/dev/null 2>&1 || true
# Delete+start so cwd/script changes (legacy npm start → current/tsx) always apply.
if pm2 describe vbizme-api >/dev/null 2>&1; then
  pm2 delete vbizme-api >/dev/null 2>&1 || true
fi
pm2 start ecosystem.config.cjs --env production
pm2 save

echo "==> Health check ${HEALTH_URL}"
ok=0
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "$HEALTH_URL" | grep -qi 'healthy\|ok\|status'; then
    ok=1
    break
  fi
  # Also accept plain 200
  code=$(curl -fsS -o /tmp/vbiz-health.json -w "%{http_code}" "$HEALTH_URL" || true)
  if [[ "$code" == "200" ]]; then
    ok=1
    break
  fi
  sleep 3
done

if [[ "$ok" -ne 1 ]]; then
  echo "ERROR: health check failed after deploy"
  echo "Roll back:"
  echo "  ln -sfn ${DEPLOY_PATH}/releases/<previous-sha> ${DEPLOY_PATH}/current && pm2 reload ecosystem.config.cjs --env production"
  exit 1
fi

echo "==> Optional smoke (cutover:check) if script present"
if [[ -f "${DEPLOY_PATH}/current/package.json" ]]; then
  (cd "${DEPLOY_PATH}/current" && SMOKE_API_URL="${HEALTH_URL%/api/v1/health}" yarn cutover:check) || true
fi

echo "==> Pruning old releases (keep ${KEEP_RELEASES})"
cd "${DEPLOY_PATH}/releases"
ls -1dt */ 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | xargs -r rm -rf

echo "==> Deploy complete: ${RELEASE_SHA}"
