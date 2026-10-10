#!/bin/sh
# Openship Russian fork installer
#
#   curl -fsSL https://raw.githubusercontent.com/AlexK420/openship/main/scripts/install-ru.sh | sh
#
# Builds AlexK420/openship from source, installs it as the regular `openship`
# command and keeps the normal ~/.openship data directory. The source-install
# marker makes `openship update` pull and rebuild this fork instead of replacing
# it with an upstream release.
#
# Env overrides:
#   OPENSHIP_REPO=<git url>     default: https://github.com/AlexK420/openship.git
#   OPENSHIP_REF=<branch|tag>   default: main
#   OPENSHIP_HOME=<dir>         default: $HOME/.openship
#   OPENSHIP_SRC_DIR=<dir>      default: $OPENSHIP_HOME/source
set -eu

info() { printf '\033[36m==>\033[0m %s\n' "$1"; }
err()  { printf '\033[31merror:\033[0m %s\n' "$1" >&2; }

command -v curl >/dev/null 2>&1 || { err "curl is required"; exit 1; }
command -v git >/dev/null 2>&1 || { err "git is required"; exit 1; }

REPO="${OPENSHIP_REPO:-https://github.com/AlexK420/openship.git}"
REF="${OPENSHIP_REF:-main}"
OPENSHIP_HOME="${OPENSHIP_HOME:-$HOME/.openship}"
SRC_DIR="${OPENSHIP_SRC_DIR:-$OPENSHIP_HOME/source}"
BIN_DIR="$OPENSHIP_HOME/bin"
LAUNCHER="$BIN_DIR/openship"

# Bun is used only for the from-source build/runtime. Install it when missing.
if ! command -v bun >/dev/null 2>&1; then
  if ! command -v unzip >/dev/null 2>&1; then
    info "Installing unzip (required by the Bun installer)..."
    SUDO=""
    if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi
    if command -v apt-get >/dev/null 2>&1; then
      $SUDO apt-get update -y || true
      $SUDO apt-get install -y unzip || true
    elif command -v dnf >/dev/null 2>&1; then
      $SUDO dnf install -y unzip || true
    elif command -v yum >/dev/null 2>&1; then
      $SUDO yum install -y unzip || true
    elif command -v apk >/dev/null 2>&1; then
      $SUDO apk add --no-cache unzip || true
    elif command -v pacman >/dev/null 2>&1; then
      $SUDO pacman -Sy --noconfirm unzip || true
    elif command -v zypper >/dev/null 2>&1; then
      $SUDO zypper install -y unzip || true
    fi
    command -v unzip >/dev/null 2>&1 || {
      err "unzip is required to install Bun. Install it and re-run."
      exit 1
    }
  fi

  info "Installing Bun..."
  curl -fsSL https://bun.sh/install | sh
  BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export BUN_INSTALL
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

command -v bun >/dev/null 2>&1 || {
  err "Bun install finished but 'bun' is not on PATH. Open a new shell and re-run."
  exit 1
}

# Clone the fork once; later runs fast-forward the tracked branch/ref.
if [ -d "$SRC_DIR/.git" ]; then
  info "Updating existing source checkout at $SRC_DIR ($REF)..."
else
  info "Cloning $REPO -> $SRC_DIR..."
  mkdir -p "$(dirname "$SRC_DIR")"
  git clone "$REPO" "$SRC_DIR"
fi

git -C "$SRC_DIR" fetch origin "$REF" --tags
git -C "$SRC_DIR" checkout "$REF"
git -C "$SRC_DIR" pull --ff-only origin "$REF" 2>/dev/null || info "Pinned ref detected; keeping the requested revision."

info "Installing workspace dependencies..."
( cd "$SRC_DIR" && bun install )
info "Building Openship CLI..."
( cd "$SRC_DIR/apps/cli" && bun run build )
info "Building the dashboard with Russian locale..."
( cd "$SRC_DIR/apps/cli" && bun run build/stage-dashboard.ts )

ENTRY="$SRC_DIR/apps/cli/dist/index.js"
DASH="$SRC_DIR/apps/dashboard/.next/standalone"
[ -f "$ENTRY" ] || { err "Build produced no CLI at $ENTRY"; exit 1; }
[ -f "$DASH/apps/dashboard/server.js" ] || { err "Build produced no dashboard at $DASH/apps/dashboard/server.js"; exit 1; }

BUN_PATH="$(command -v bun)"
mkdir -p "$BIN_DIR"
cat > "$LAUNCHER" <<EOF_LAUNCHER
#!/bin/sh
export OPENSHIP_HOME="$OPENSHIP_HOME"
export OPENSHIP_DASHBOARD_DIR="$DASH"
exec "$BUN_PATH" "$ENTRY" "\$@"
EOF_LAUNCHER
chmod +x "$LAUNCHER"

# Mark this as a source install. `openship update` will now pull this repo/ref,
# rebuild apps/cli + dashboard, and restart/reconcile the running installation.
mkdir -p "$OPENSHIP_HOME"
cat > "$OPENSHIP_HOME/source-install.json" <<EOF_MARKER
{
  "repo": "$REPO",
  "ref": "$REF",
  "dir": "$SRC_DIR"
}
EOF_MARKER
# Avoid a stale tarball marker from an older official curl installation.
rm -f "$OPENSHIP_HOME/cli-install.json"

# Remove an old Bun-global package/launcher that could shadow this install.
bun remove -g openship >/dev/null 2>&1 || true
rm -f "$HOME/.bun/bin/openship" 2>/dev/null || true

# Put the stable launcher on PATH using the same locations as the official installer.
LINKED=""
for d in "/usr/local/bin" "$HOME/.local/bin"; do
  if [ -d "$d" ] && [ -w "$d" ]; then
    ln -sf "$LAUNCHER" "$d/openship" && { LINKED="$d/openship"; break; }
  fi
done
if [ -z "$LINKED" ] && mkdir -p "$HOME/.local/bin" 2>/dev/null && [ -w "$HOME/.local/bin" ]; then
  ln -sf "$LAUNCHER" "$HOME/.local/bin/openship" && LINKED="$HOME/.local/bin/openship"
fi

RESOLVED="$(command -v openship 2>/dev/null || true)"
if [ -n "$RESOLVED" ] && [ "$RESOLVED" != "$LAUNCHER" ] && [ "$RESOLVED" != "$LINKED" ]; then
  info "Another 'openship' is earlier on PATH: $RESOLVED"
  info "Remove it, or put $BIN_DIR first in PATH."
fi

cat <<EOF_DONE

$(printf '\033[32mOK\033[0m') Openship Russian fork installed from $REF.

  openship            # interactive setup / run
  openship up         # start with defaults
  openship update     # pull $REPO ($REF) and rebuild
  openship --help     # all commands

  Home:    $OPENSHIP_HOME
  Source:  $SRC_DIR
  Repo:    $REPO
EOF_DONE

if [ -z "$LINKED" ]; then
  cat <<EOF_PATH

'openship' is not on PATH yet. Add:
  export PATH="$BIN_DIR:\$PATH"
EOF_PATH
fi
