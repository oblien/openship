#!/bin/sh
# Openship installer — https://get.openship.io
#
#   curl -fsSL https://get.openship.io | sh
#
# Installs the Openship CLI. Then `openship up` runs Openship locally (API +
# dashboard), or `openship install` fetches the desktop app. Bun is the runtime;
# this script installs it for you if it's missing (no Node or npm needed).
#
# Env overrides:
#   OPENSHIP_VERSION=0.1.9   pin a specific CLI version (default: latest)
set -eu

info() { printf '\033[36m==>\033[0m %s\n' "$1"; }
err()  { printf '\033[31merror:\033[0m %s\n' "$1" >&2; }

command -v curl >/dev/null 2>&1 || { err "curl is required"; exit 1; }

# 1. Ensure Bun (the runtime). Installs to ~/.bun by default; no Node/npm.
if ! command -v bun >/dev/null 2>&1; then
  # Bun's installer unpacks a .zip, so it needs `unzip` — minimal server images
  # (Ubuntu/Debian netinstall, Alpine, …) don't ship it, and Bun then dies with
  # a cryptic "unzip is required". Install it first via whatever package manager
  # is present (root or via sudo), else fail with a clear, actionable message.
  if ! command -v unzip >/dev/null 2>&1; then
    info "Installing unzip (required by the Bun installer)…"
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
      err "unzip is required to install Bun but couldn't be installed automatically. Install it (e.g. 'apt-get install unzip') and re-run."
      exit 1
    }
  fi

  info "Installing the Bun runtime…"
  curl -fsSL https://bun.sh/install | bash
  BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export BUN_INSTALL
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

command -v bun >/dev/null 2>&1 || {
  err "Bun install finished but 'bun' is not on PATH. Open a new shell and re-run."
  exit 1
}

# 2. Install the Openship CLI globally (fetched from the registry by Bun —
#    the npm CLI itself is never invoked).
PKG="openship"
[ -n "${OPENSHIP_VERSION:-}" ] && PKG="openship@${OPENSHIP_VERSION}"
info "Installing the Openship CLI (${PKG})…"
bun add -g "$PKG"

BUN_BIN="${BUN_INSTALL:-$HOME/.bun}/bin"
CLI_JS="${BUN_INSTALL:-$HOME/.bun}/install/global/node_modules/openship/dist/index.js"

# 3. Heal installs broken by the pre-fix installer (issue #21). That version
#    wrote the Bun launcher THROUGH the bin symlink, clobbering the compiled
#    entry (dist/index.js) with a /bin/sh script that execs itself. `bun add`
#    above can no-op on a cache hit and leave the clobbered file, so detect the
#    tell-tale shell shebang and force a clean reinstall to restore the bundle.
if [ -f "$CLI_JS" ] && IFS= read -r _first_line < "$CLI_JS" && [ "$_first_line" = "#!/bin/sh" ]; then
  info "Repairing a previously broken install…"
  bun remove -g openship >/dev/null 2>&1 || true
  bun add -g "$PKG"
fi

# 4. Bun-only fallback. The published CLI carries a Node shebang
#    (#!/usr/bin/env node), so on a box with no Node the global shim can't
#    launch. Point it at a launcher that runs the CLI under Bun instead (Bun
#    executes the Node-target bundle fine) — so `openship` works Node-free.
if ! command -v node >/dev/null 2>&1; then
  BUN_PATH="$(command -v bun)"
  if [ -n "$BUN_PATH" ] && [ -f "$CLI_JS" ]; then
    info "Node not found — wiring 'openship' to run under Bun."
    # `bun add -g` links $BUN_BIN/openship as a SYMLINK to dist/index.js. A
    # plain `>` redirect follows that symlink and writes the wrapper THROUGH it
    # — clobbering the compiled entry with a script that then execs itself (the
    # #21 self-referential loop / "Expected ;" syntax error). Unlink first so
    # the redirect creates a standalone launcher and dist/index.js is untouched.
    rm -f "$BUN_BIN/openship"
    printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$BUN_PATH" "$CLI_JS" > "$BUN_BIN/openship"
    chmod +x "$BUN_BIN/openship"
  fi
fi

# 5. Docker is the CLI's job, not ours. `openship up` / the wizard install it via
#    ensureDocker() only when they actually need the compose stack — this script also
#    runs on laptops and CI that just manage REMOTE servers. (OPENSHIP_SKIP_DOCKER is
#    still accepted; it no longer does anything.)
#
#    The one thing the CLI can't fix for you: group membership needs a new login.
if [ "$(uname -s)" = "Linux" ] \
  && command -v docker >/dev/null 2>&1 \
  && ! docker info >/dev/null 2>&1 \
  && [ "$(id -u)" -ne 0 ] \
  && ! id -nG | tr ' ' '\n' | grep -qx docker; then
  info "Docker is installed but your user can't reach the daemon."
  info "Fix: sudo usermod -aG docker $(id -un) — then log out and back in (or: newgrp docker)."
fi

# 6. Next steps.
cat <<EOF

$(printf '\033[32m✔\033[0m') Openship installed.

  $(printf '\033[1mopenship\033[0m')            # set up + deploy Openship (interactive)

  openship up         # or launch directly with defaults
  openship --help     # all commands

If 'openship' isn't found, add Bun's global bin to your PATH:
  export PATH="${BUN_BIN}:\$PATH"
EOF
