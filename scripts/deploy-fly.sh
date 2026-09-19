#!/usr/bin/env bash
#
# Deploy FriendZone to Fly.io.
#
# Idempotent: safe to re-run. It creates only what is missing, and never
# overwrites an existing secret.
#
#   fly auth login     # once, opens a browser
#   ./scripts/deploy-fly.sh
#
set -euo pipefail

export PATH="$HOME/.fly/bin:$PATH"

APP="${FLY_APP:-friendzone}"
REGION="${FLY_REGION:-sin}"
PG="${APP}-db"
REDIS="${APP}-redis"

command -v flyctl >/dev/null || { echo "flyctl not found. See https://fly.io/docs/flyctl/install/"; exit 1; }

flyctl auth whoami >/dev/null 2>&1 || {
  echo
  echo "  Not logged in. Run this first, then re-run this script:"
  echo
  echo "    flyctl auth login"
  echo
  exit 1
}

echo "==> Deploying as $(flyctl auth whoami)"

# --- the app ---------------------------------------------------------------
if ! flyctl apps list 2>/dev/null | grep -qE "^${APP}[[:space:]]"; then
  echo "==> Creating app ${APP}"
  flyctl apps create "${APP}" --machines
else
  echo "==> App ${APP} already exists"
fi

# --- Postgres --------------------------------------------------------------
# Attaching sets DATABASE_URL as a secret on the app.
if ! flyctl apps list 2>/dev/null | grep -qE "^${PG}[[:space:]]"; then
  echo "==> Creating Postgres ${PG}"
  flyctl postgres create --name "${PG}" --region "${REGION}" \
    --initial-cluster-size 1 --vm-size shared-cpu-1x --volume-size 1
  flyctl postgres attach "${PG}" --app "${APP}" --yes
else
  echo "==> Postgres ${PG} already exists"
fi

# --- Redis -----------------------------------------------------------------
# Upstash via Fly. Prints a connection string we copy into a secret.
if ! flyctl redis list 2>/dev/null | grep -q "${REDIS}"; then
  echo "==> Creating Redis ${REDIS}"
  flyctl redis create --name "${REDIS}" --region "${REGION}" --no-replicas --enable-eviction=false
fi

if ! flyctl secrets list --app "${APP}" 2>/dev/null | grep -q REDIS_URL; then
  echo "==> Attaching Redis"
  REDIS_URL="$(flyctl redis status "${REDIS}" --json 2>/dev/null | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).private_url || ""')"
  [ -n "${REDIS_URL}" ] || { echo "Could not read the Redis URL. Run: flyctl redis status ${REDIS}"; exit 1; }
  flyctl secrets set --app "${APP}" --stage "REDIS_URL=${REDIS_URL}"
fi

# --- secrets ---------------------------------------------------------------
# Generated once and left alone. Rotating SESSION_SECRET signs every player out.
if ! flyctl secrets list --app "${APP}" 2>/dev/null | grep -q SESSION_SECRET; then
  echo "==> Generating SESSION_SECRET"
  flyctl secrets set --app "${APP}" --stage \
    "SESSION_SECRET=$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')"
fi

ORIGIN="https://${APP}.fly.dev"
flyctl secrets set --app "${APP}" --stage \
  "CORS_ORIGINS=${ORIGIN}" "PUBLIC_WEB_ORIGIN=${ORIGIN}" >/dev/null

# --- deploy ----------------------------------------------------------------
# Real photographs need a contact address, as Wikimedia asks of automated
# clients. Without one the build generates placeholder art, which plays the same.
UA="${WIKIMEDIA_USER_AGENT:-FriendZone/1.0 (https://github.com/ysai258/friendzone)}"

echo "==> Building and deploying (the image build fetches ~78 images; a few minutes)"
flyctl deploy --app "${APP}" --build-arg "WIKIMEDIA_USER_AGENT=${UA}" --ha=false

echo
echo "  Live at ${ORIGIN}"
echo "  Share that link. Open it, create a room, hit Copy link."
echo
