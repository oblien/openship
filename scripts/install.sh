#!/bin/sh
# Openship installer — https://get.openship.io
#
#   curl -fsSL https://get.openship.io | sh
#
# Installs the Openship CLI as a self-contained, sha256-verified payload that
# runs under NODE. Node is the shipped runtime: this installer prefers a system
# `node` >= 22 and otherwise vendors an official Node 22 from nodejs.org into
# ~/.openship/runtime — it NEVER installs, pins, or gates the user's global
# runtime (the source of the Bun-vs-ssh2 crash class, oven-sh/bun#18546).
#
# After install: `openship` (interactive) or `openship up` runs Openship locally
# (API + dashboard); `openship install` fetches the desktop app.
#
# Env overrides:
#   OPENSHIP_VERSION=0.5.0        pin a CLI version (default: latest release)
#   OPENSHIP_HOME=~/.openship     install root (data dir, runtime, launcher)
#   OPENSHIP_CLI_ASSET_URL=…      download the payload tarball from here instead
#                                 of GitHub (its .sha256 sidecar must sit beside
#                                 it); for testing an unpublished build
set -eu

info() { printf '\033[36m==>\033[0m %s\n' "$1"; }
err()  { printf '\033[31merror:\033[0m %s\n' "$1" >&2; }

REPO="oblien/openship"
NODE_MAJOR=22
NODE_DIST="https://nodejs.org/dist"

HOME_DIR="${OPENSHIP_HOME:-$HOME/.openship}"
CLI_DIR="$HOME_DIR/cli"
RUNTIME_DIR="$HOME_DIR/runtime"
BIN_DIR="$HOME_DIR/bin"
LAUNCHER="$BIN_DIR/openship"

command -v curl >/dev/null 2>&1 || { err "curl is required"; exit 1; }
command -v tar  >/dev/null 2>&1 || { err "tar is required"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# sha256 of a file, using whichever tool the box ships.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}';
  else err "need sha256sum or shasum to verify downloads"; exit 1; fi
}

# ── 1. Resolve the release tag ──────────────────────────────────────────────
if [ -n "${OPENSHIP_VERSION:-}" ]; then
  case "$OPENSHIP_VERSION" in v*) TAG="$OPENSHIP_VERSION" ;; *) TAG="v$OPENSHIP_VERSION" ;; esac
else
  info "Resolving the latest release…"
  TAG="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep -oE '"tag_name"[[:space:]]*:[[:space:]]*"[^"]+"' | head -n1 \
    | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
  [ -n "$TAG" ] || { err "could not resolve the latest release tag from GitHub"; exit 1; }
fi

# ── 2. Download + verify + extract the payload → cli/<tag> ──────────────────
ASSET="openship-cli-${TAG}.tar.gz"
if [ -n "${OPENSHIP_CLI_ASSET_URL:-}" ]; then
  ASSET_URL="$OPENSHIP_CLI_ASSET_URL"
else
  ASSET_URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"
fi

info "Downloading the Openship CLI (${TAG})…"
curl -fSL "$ASSET_URL" -o "$TMP/$ASSET"
# Fail-closed: no sidecar → refuse to install an unverified payload.
EXPECT="$(curl -fsSL "${ASSET_URL}.sha256" 2>/dev/null | awk '{print $1}' | head -n1)"
[ -n "$EXPECT" ] || { err "no .sha256 sidecar for ${ASSET} — refusing an unverified install"; exit 1; }
ACTUAL="$(sha256_of "$TMP/$ASSET")"
[ "$EXPECT" = "$ACTUAL" ] || { err "payload checksum mismatch (expected ${EXPECT}, got ${ACTUAL})"; exit 1; }

TARGET="$CLI_DIR/$TAG"
rm -rf "$TARGET"; mkdir -p "$TARGET"
tar -xzf "$TMP/$ASSET" -C "$TARGET"
[ -f "$TARGET/dist/index.js" ] || { err "payload extracted but dist/index.js is missing (bad tarball)"; exit 1; }
: > "$TARGET/.extracted"
# Repoint cli/current atomically-ish (relative link, survives a moved home).
rm -rf "$CLI_DIR/current"; ln -s "$TAG" "$CLI_DIR/current"

# Prune old payloads, keeping current + the newest 2 (the in-use one survives).
( cd "$CLI_DIR" 2>/dev/null && ls -1dt */ 2>/dev/null | sed 's#/$##' \
    | grep -v '^current$' | tail -n +3 \
    | while read -r d; do [ "$d" = "$TAG" ] || rm -rf "$d"; done ) || true

# ── 3. Resolve Node: system >= NODE_MAJOR, else vendor from nodejs.org ───────
NODE_SOURCE=system
if command -v node >/dev/null 2>&1 \
  && node -e "process.exit(+process.versions.node.split('.')[0]>=${NODE_MAJOR}?0:1)" 2>/dev/null; then
  info "Using system Node $(node --version)."
else
  NODE_SOURCE=vendored
  case "$(uname -s)" in
    Linux)  NODE_OS=linux ;;
    Darwin) NODE_OS=darwin ;;
    *) err "no system Node >= ${NODE_MAJOR} and no vendored build for $(uname -s) — install Node 22+ and re-run"; exit 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)  NODE_ARCH=x64 ;;
    arm64|aarch64) NODE_ARCH=arm64 ;;
    *) err "unsupported CPU arch for vendored Node: $(uname -m) — install Node 22+ and re-run"; exit 1 ;;
  esac

  info "No system Node >= ${NODE_MAJOR} — fetching an official Node ${NODE_MAJOR} from nodejs.org…"
  NODE_VER="$(curl -fsSL "${NODE_DIST}/index.json" 2>/dev/null \
    | grep -oE "\"v${NODE_MAJOR}\.[0-9]+\.[0-9]+\"" | head -n1 | tr -d '"')"
  [ -n "$NODE_VER" ] || { err "could not resolve a Node ${NODE_MAJOR}.x version from nodejs.org"; exit 1; }

  NODE_NAME="node-${NODE_VER}-${NODE_OS}-${NODE_ARCH}.tar.gz"
  curl -fSL "${NODE_DIST}/${NODE_VER}/${NODE_NAME}" -o "$TMP/$NODE_NAME"
  NODE_EXPECT="$(curl -fsSL "${NODE_DIST}/${NODE_VER}/SHASUMS256.txt" 2>/dev/null \
    | grep "  ${NODE_NAME}\$" | awk '{print $1}')"
  [ -n "$NODE_EXPECT" ] || { err "no checksum for ${NODE_NAME} in SHASUMS256.txt"; exit 1; }
  NODE_ACTUAL="$(sha256_of "$TMP/$NODE_NAME")"
  [ "$NODE_EXPECT" = "$NODE_ACTUAL" ] || { err "Node download checksum mismatch"; exit 1; }

  mkdir -p "$RUNTIME_DIR"
  tar -xzf "$TMP/$NODE_NAME" -C "$RUNTIME_DIR"
  rm -rf "$RUNTIME_DIR/current"
  ln -s "node-${NODE_VER}-${NODE_OS}-${NODE_ARCH}" "$RUNTIME_DIR/current"
  [ -x "$RUNTIME_DIR/current/bin/node" ] || { err "vendored Node unpacked but bin/node is missing"; exit 1; }
fi

# ── 4. Write the stable launcher (kept identical to lib/node-runtime.ts) ────
mkdir -p "$BIN_DIR"
cat > "$LAUNCHER" <<'LAUNCHER_EOF'
#!/bin/sh
# Openship CLI launcher — runs the tarball-installed CLI under Node.
# Managed by scripts/install.sh and `openship update`; manual edits are overwritten.
SELF="$0"
while [ -L "$SELF" ]; do
  _t="$(readlink "$SELF")"
  case "$_t" in /*) SELF="$_t" ;; *) SELF="$(dirname "$SELF")/$_t" ;; esac
done
BIN_DIR="$(cd "$(dirname "$SELF")" && pwd)"
HOME_DIR="$(dirname "$BIN_DIR")"
CLI="$HOME_DIR/cli/current/dist/index.js"
VENDORED_NODE="$HOME_DIR/runtime/current/bin/node"
# Prefer a system node >= 22; fall back to the vendored runtime.
if command -v node >/dev/null 2>&1 && node -e 'process.exit(+process.versions.node.split(".")[0]>=22?0:1)' 2>/dev/null; then
  exec node "$CLI" "$@"
elif [ -x "$VENDORED_NODE" ]; then
  exec "$VENDORED_NODE" "$CLI" "$@"
else
  echo "openship: no Node >= 22 found (system or vendored). Reinstall: curl -fsSL https://get.openship.io | sh" >&2
  exit 127
fi
LAUNCHER_EOF
chmod +x "$LAUNCHER"

# ── 5. Record the distribution marker (read by `openship update`) ───────────
cat > "$HOME_DIR/cli-install.json" <<EOF
{
  "method": "tarball",
  "tag": "${TAG}",
  "launcher": "${LAUNCHER}",
  "runtime": "${NODE_SOURCE}"
}
EOF

# ── 6. Migrate off any previous Bun-global install (never touch the user's Bun) ─
if command -v bun >/dev/null 2>&1; then
  bun remove -g openship >/dev/null 2>&1 || true
fi
rm -f "$HOME/.bun/bin/openship" 2>/dev/null || true

# ── 7. Put `openship` on PATH ───────────────────────────────────────────────
LINKED=""
for d in "/usr/local/bin" "$HOME/.local/bin"; do
  if [ -d "$d" ] && [ -w "$d" ]; then
    ln -sf "$LAUNCHER" "$d/openship" && { LINKED="$d/openship"; break; }
  fi
done
if [ -z "$LINKED" ] && mkdir -p "$HOME/.local/bin" 2>/dev/null && [ -w "$HOME/.local/bin" ]; then
  ln -sf "$LAUNCHER" "$HOME/.local/bin/openship" && LINKED="$HOME/.local/bin/openship"
fi

# A leftover launcher earlier on PATH (e.g. ~/.bun/bin) would shadow ours.
RESOLVED="$(command -v openship 2>/dev/null || true)"
if [ -n "$RESOLVED" ] && [ "$RESOLVED" != "$LAUNCHER" ] && [ "$RESOLVED" != "$LINKED" ]; then
  info "Note: another 'openship' is earlier on PATH ($RESOLVED). Remove it, or put $BIN_DIR first."
fi

# ── 8. Docker-group advisory (the CLI installs Docker itself when a deploy needs it) ─
if [ "$(uname -s)" = "Linux" ] \
  && command -v docker >/dev/null 2>&1 \
  && ! docker info >/dev/null 2>&1 \
  && [ "$(id -u)" -ne 0 ] \
  && ! id -nG | tr ' ' '\n' | grep -qx docker; then
  info "Docker is installed but your user can't reach the daemon."
  info "Fix: sudo usermod -aG docker $(id -un) — then log out and back in (or: newgrp docker)."
fi

# ── 9. Next steps ───────────────────────────────────────────────────────────
cat <<EOF

$(printf '\033[32m✔\033[0m') Openship installed (${TAG}, running under ${NODE_SOURCE} Node).

  $(printf '\033[1mopenship\033[0m')            # set up + deploy Openship (interactive)

  openship up         # or launch directly with defaults
  openship --help     # all commands
EOF
if [ -z "$LINKED" ]; then
  cat <<EOF

'openship' isn't on your PATH yet. Add its bin dir:
  export PATH="${BIN_DIR}:\$PATH"
EOF
fi
