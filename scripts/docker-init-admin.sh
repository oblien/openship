#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Declarative first-admin bootstrap for the Docker Compose stack.
#
# Compose has no equivalent of `openship up`'s interactive setup wizard, so a
# fresh `docker compose up` used to leave the instance with no way to create the
# first administrator through the web flow (public sign-up is disabled, and the
# loopback bootstrap shortcut never fires because the request reaches the API
# from a Docker-bridge IP, not 127.0.0.1). See issue #138.
#
# This one-shot service closes that gap WITHOUT enabling public sign-up: it
# calls the existing internal-token-gated `POST /api/system/bootstrap-admin`
# endpoint — the same endpoint the CLI wizard uses — with the credentials the
# operator declared in `.env`.
#
# It is a no-op unless OPENSHIP_ADMIN_EMAIL and OPENSHIP_ADMIN_PASSWORD are set,
# and it is idempotent: bootstrap-admin refuses (409) once an admin exists, so
# re-running `docker compose up` never changes an existing admin. Operators who
# prefer the CLI or a manual first sign-in can simply leave the vars unset.
# ─────────────────────────────────────────────────────────────────────────────
set -eu

API_URL="${OPENSHIP_API_URL:-http://api:4000}"
ADMIN_NAME="${OPENSHIP_ADMIN_NAME:-Admin}"

if [ -z "${OPENSHIP_ADMIN_EMAIL:-}" ] || [ -z "${OPENSHIP_ADMIN_PASSWORD:-}" ]; then
  echo "[init-admin] OPENSHIP_ADMIN_EMAIL / OPENSHIP_ADMIN_PASSWORD not set — skipping declarative admin bootstrap."
  echo "[init-admin] Create the first admin with the CLI, or set those vars in .env and re-run \`docker compose up\`."
  exit 0
fi

if [ -z "${INTERNAL_TOKEN:-}" ]; then
  echo "[init-admin] INTERNAL_TOKEN is not set. The API requires it and so does this bootstrap. Aborting." >&2
  exit 1
fi

# Build the JSON body with a tiny Python helper if available; otherwise fall back
# to a manual escape. curl images ship neither jq nor python, so escape inline.
escape() {
  # Escape backslash, double-quote and control chars for a JSON string value.
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

body="{\"name\":\"$(escape "$ADMIN_NAME")\",\"email\":\"$(escape "$OPENSHIP_ADMIN_EMAIL")\",\"password\":\"$(escape "$OPENSHIP_ADMIN_PASSWORD")\"}"

echo "[init-admin] Bootstrapping first admin for ${OPENSHIP_ADMIN_EMAIL} via ${API_URL} …"

status="$(
  curl -sS -o /tmp/init-admin-response -w '%{http_code}' \
    -X POST "${API_URL}/api/system/bootstrap-admin" \
    -H 'Content-Type: application/json' \
    -H "X-Internal-Token: ${INTERNAL_TOKEN}" \
    --data "${body}"
)" || {
  echo "[init-admin] Could not reach the API at ${API_URL}. Is the api service healthy?" >&2
  exit 1
}

case "${status}" in
  200)
    echo "[init-admin] First admin created for ${OPENSHIP_ADMIN_EMAIL}. Sign in at the dashboard."
    ;;
  409)
    echo "[init-admin] An admin already exists — nothing to do (bootstrap is one-shot)."
    ;;
  401)
    echo "[init-admin] API rejected the internal token (401). Ensure INTERNAL_TOKEN matches the api service." >&2
    exit 1
    ;;
  *)
    echo "[init-admin] bootstrap-admin failed (HTTP ${status}):" >&2
    cat /tmp/init-admin-response >&2 2>/dev/null || true
    echo >&2
    exit 1
    ;;
esac
