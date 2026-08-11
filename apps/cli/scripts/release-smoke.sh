#!/usr/bin/env bash
#
# Release smoke gate for the `openship` CLI.
#
# The unit/e2e suite exercises command LOGIC against the SOURCE with mocks — it
# never runs the published tsup BUNDLE, never goes through the shebang, and never
# boots a real server. Every recent CLI break slipped through that gap:
#
#   0.4.4  "Dynamic require of events"  — bundle-only, and hidden under Bun
#   #257   server exits: OPENSHIP_AUTH_MODE required — nothing booted the server
#   #261   `env: node: not found`       — shebang bypassed; no no-Node box tested
#
# This gate runs the ACTUAL built artifact across the runtimes and install
# shapes users actually hit, and boots the real server. Any failure exits
# non-zero so the release stops BEFORE the immutable npm publish.
#
# Usage:  bash apps/cli/scripts/release-smoke.sh
#   SMOKE_SKIP_BUILD=1   reuse the existing dist/ instead of rebuilding
#   SMOKE_SKIP_BOOT=1    skip the heavier server-boot probe (C5)
set -u

CLI_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$CLI_DIR/dist/index.js"
SERVER="$CLI_DIR/dist/server/index.js"
FAILED=0
VER_RE='^[0-9]+\.[0-9]+\.[0-9]+'

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAILED=1; }
group() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# ── build ────────────────────────────────────────────────────────────────
if [ "${SMOKE_SKIP_BUILD:-}" != "1" ]; then
  group "Building CLI (dist + staged server)…"
  (cd "$CLI_DIR" && bun run build) >/dev/null 2>&1 || { echo "build failed"; exit 1; }
fi
[ -f "$DIST" ] || { echo "no dist/index.js — build the CLI first"; exit 1; }

# ── C1/C2: launch under each runtime (catches the bundle-only crash class) ──
# A launch check must load the FULL import graph, so `up --help` (which pulls in
# the ws/docker chunk that crashed 0.4.4) — not just --version.
check_runtime() {
  runtime="$1"; bin="$2"
  command -v "$bin" >/dev/null 2>&1 || { fail "$runtime not on PATH (cannot verify)"; return; }
  v="$("$bin" "$DIST" --version 2>&1)"
  if [ "$?" -eq 0 ] && printf '%s' "$v" | grep -qE "$VER_RE"; then
    pass "$runtime: --version → $v"
  else
    fail "$runtime: --version failed → $v"; return
  fi
  if "$bin" "$DIST" up --help 2>&1 | grep -qF -- "--compose"; then
    pass "$runtime: up --help renders (full import graph loads)"
  else
    fail "$runtime: up --help failed to load"
  fi
}
group "C1/C2 — launch under each runtime"
check_runtime "node" node
check_runtime "bun" bun

# ── C3: real shebang (direct exec goes through the polyglot launcher) ───────
group "C3 — shebang / direct exec"
chmod +x "$DIST"
v="$("$DIST" --version 2>&1)"
if [ "$?" -eq 0 ] && printf '%s' "$v" | grep -qE "$VER_RE"; then
  pass "direct ./dist/index.js → $v (polyglot picked a runtime)"
else
  fail "direct exec failed → $v"
fi

# ── C4: no-Node box (the official Bun-only installer's result — #261) ───────
group "C4 — no-Node environment (Bun-only box)"
if ! command -v bun >/dev/null 2>&1; then
  fail "bun not available — cannot simulate a no-Node box"
else
  BINDIR="$(mktemp -d)"
  ln -s "$(command -v sh)" "$BINDIR/sh"
  ln -s "$(command -v bun)" "$BINDIR/bun"
  if PATH="$BINDIR" sh -c 'command -v node' >/dev/null 2>&1; then
    fail "node still visible under restricted PATH — test is not isolating"
  else
    v="$(PATH="$BINDIR" "$DIST" --version 2>&1)"
    if [ "$?" -eq 0 ] && printf '%s' "$v" | grep -qE "$VER_RE"; then
      pass "runs with only sh+bun on PATH → $v"
    else
      fail "failed on a no-Node box → $v"
    fi
  fi
  rm -rf "$BINDIR"
fi

# ── C5: real server boot (catches an env the CLI forgets to pass — #257) ────
# Runs the REAL `openship up` env-building path against the REAL bundled server.
# --no-ui keeps it offline (no dashboard download); --data-dir + OPENSHIP_HOME
# isolate it from any dev instance. `up` polls /api/health itself, so a server
# that exits on a missing env var (e.g. OPENSHIP_AUTH_MODE) never goes healthy.
if [ "${SMOKE_SKIP_BOOT:-}" = "1" ]; then
  group "C5 — server boot probe (SKIPPED via SMOKE_SKIP_BOOT=1)"
elif [ ! -f "$SERVER" ]; then
  group "C5 — server boot probe"
  fail "no staged server bundle at dist/server/index.js"
else
  group "C5 — real server boot (openship up --foreground --no-ui)"
  PORT=$(( 40000 + (RANDOM % 20000) ))
  WORK="$(mktemp -d)"; LOG="$WORK/up.log"
  OPENSHIP_HOME="$WORK/home" node "$DIST" up --foreground --no-ui \
    --port "$PORT" --data-dir "$WORK/data" >"$LOG" 2>&1 &
  UP_PID=$!
  disown "$UP_PID" 2>/dev/null || true    # no "Terminated" job-control noise on kill
  ok=0
  for _ in $(seq 1 80); do            # up to ~40s (pglite init + migrations)
    if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then ok=1; break; fi
    kill -0 "$UP_PID" 2>/dev/null || break     # CLI exited early = boot failed
    sleep 0.5
  done
  # Tear down the CLI and its detached API child. `openship stop` (same
  # OPENSHIP_HOME) reaps the tracked server — the child carries the data dir in
  # its ENV, not argv, so pkill couldn't target it.
  kill "$UP_PID" 2>/dev/null
  OPENSHIP_HOME="$WORK/home" node "$DIST" stop >/dev/null 2>&1 || true
  if [ "$ok" -eq 1 ]; then
    pass "API became healthy on :$PORT"
  else
    fail "server never became healthy — tail of log:"
    tail -n 25 "$LOG" | sed 's/^/      /'
  fi
  # Belt-and-suspenders: the #257 signature must never appear.
  if grep -q "OPENSHIP_AUTH_MODE is required" "$LOG" 2>/dev/null; then
    fail "server refused to boot: OPENSHIP_AUTH_MODE not declared by the CLI (#257)"
  fi
  rm -rf "$WORK"
fi

# ── verdict ─────────────────────────────────────────────────────────────
echo
if [ "$FAILED" -eq 0 ]; then
  printf '\033[32m✔ release smoke passed — the built CLI launches (node/bun/shebang/no-node) and the server boots.\033[0m\n'
else
  printf '\033[31m✗ release smoke FAILED — do not publish.\033[0m\n'
  exit 1
fi
