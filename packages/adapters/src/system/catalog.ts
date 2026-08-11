import type { EnvironmentProfile } from "./environment";

export interface ComponentCheckCatalogEntry {
  versionCommand: string;
  parseVersion: (output: string) => string;
  daemonCommand?: string;
  runningCommands?: string[];
  missingMessage: string;
  notRunningMessage?: string;
}

export interface InstallPlan {
  supported: boolean;
  unsupportedReason?: string;
  installCommand?: string;
  startCommand?: string;
  verifyCommand?: string;
  fallbackInstallCommands?: string[];
}

function dockerInstallPlan(profile: EnvironmentProfile): InstallPlan {
  if (profile.os !== "linux") {
    return {
      supported: false,
      unsupportedReason: "Docker installation is only supported on Linux servers",
    };
  }

  return {
    supported: true,
    installCommand: "curl -fsSL https://get.docker.com | sh",
    startCommand:
      profile.serviceManager === "systemd"
        ? "systemctl enable docker && systemctl start docker"
        : undefined,
    verifyCommand: "docker --version",
  };
}

function gitInstallPlan(profile: EnvironmentProfile): InstallPlan {
  const commands: Record<string, string> = {
    apt: "apt-get update -qq && apt-get install -y -qq git",
    dnf: "dnf install -y git",
    yum: "yum install -y git",
    apk: "apk add --no-cache git",
    brew: "brew install git",
  };

  const installCommand = commands[profile.packageManager];
  if (!installCommand) {
    return {
      supported: false,
      unsupportedReason: "No supported package manager found for Git installation",
    };
  }

  return {
    supported: true,
    installCommand,
    verifyCommand: "git --version",
  };
}

function rsyncInstallPlan(profile: EnvironmentProfile): InstallPlan {
  const commands: Record<string, string> = {
    apt: "apt-get update -qq && apt-get install -y -qq rsync",
    dnf: "dnf install -y rsync",
    yum: "yum install -y rsync",
    apk: "apk add --no-cache rsync",
    brew: "brew install rsync",
  };

  const installCommand = commands[profile.packageManager];
  if (!installCommand) {
    return {
      supported: false,
      unsupportedReason: "No supported package manager found for rsync installation",
    };
  }

  return {
    supported: true,
    installCommand,
    verifyCommand: "rsync --version | head -n 1",
  };
}

/**
 * Shell that writes /etc/apt/sources.list.d/openresty.list with a codename
 * openresty.org actually publishes. openresty.org ships LTS-only repos (newest
 * ubuntu=noble, debian=bookworm), so a non-LTS or not-yet-published codename —
 * e.g. Ubuntu 26.04 "resolute" — has no Release file and breaks `apt-get update`
 * (and every later apt step in the same run). We probe the live repo for the
 * detected codename, then walk down to the nearest supported LTS, warning when we
 * deviate. Expects $REPO set to "ubuntu" or "debian"; assumes wget is installed.
 */
const OPENRESTY_APT_SOURCES: string[] = [
  // ARM64: openresty.org publishes aarch64 debs under a SEPARATE path
  // (openresty.org/package/arm64/<repo>); the default path is amd64-only, so on
  // aarch64 `apt-get install openresty` finds no candidate and `set -e` aborts
  // the whole setup (issue #109). Switch the base URL by arch and tag the deb
  // line with `arch=` so apt fetches the right index. `dpkg --print-architecture`
  // returns exactly amd64/arm64 (matches OpenResty's path + arch qualifier).
  'OR_ARCH="$(dpkg --print-architecture 2>/dev/null || echo amd64)"',
  'if [ "$OR_ARCH" = arm64 ]; then OR_BASE="http://openresty.org/package/arm64/$REPO"; else OR_BASE="http://openresty.org/package/$REPO"; fi',
  // `|| REPO_CODENAME=""` so a failed substitution (no lsb_release AND no
  // /etc/os-release, e.g. a stripped container) doesn't trip `set -e` before
  // the empty-var fallback below can pick a default.
  'REPO_CODENAME="$(lsb_release -sc 2>/dev/null || { . /etc/os-release 2>/dev/null && echo "$VERSION_CODENAME"; })" || REPO_CODENAME=""',
  'if [ "$REPO" = debian ]; then OR_FALLBACKS="bookworm bullseye"; else OR_FALLBACKS="noble jammy focal"; fi',
  'OR_CODENAME=""',
  'for c in $REPO_CODENAME $OR_FALLBACKS; do',
  '  if wget -q --spider --tries=2 --timeout=15 "$OR_BASE/dists/$c/Release"; then OR_CODENAME="$c"; break; fi',
  'done',
  'if [ -z "$OR_CODENAME" ]; then case "$REPO" in debian) OR_CODENAME=bookworm ;; *) OR_CODENAME=noble ;; esac; fi',
  '[ "$OR_CODENAME" = "$REPO_CODENAME" ] || echo "[openresty] apt repo has no codename $REPO_CODENAME; using nearest supported LTS $OR_CODENAME" >&2',
  'echo "deb [arch=$OR_ARCH signed-by=/usr/share/keyrings/openresty.gpg] $OR_BASE $OR_CODENAME main" > /etc/apt/sources.list.d/openresty.list',
];

function openrestyInstallPlan(profile: EnvironmentProfile): InstallPlan {
  if (profile.os !== "linux") {
    return {
      supported: false,
      unsupportedReason: "OpenResty installation is only supported on Linux servers",
    };
  }

  let installCommand: string;

  if (profile.packageManager === "apt") {
    const distro = profile.distro === "debian" ? "debian" : "ubuntu";
    installCommand = [
      "set -e",
      // Heal a stale/bad openresty.list left by a prior run (e.g. the #86
      // 'resolute' pin) BEFORE the first apt-get update reads it — otherwise
      // set -e aborts here and the repo never gets rewritten.
      "rm -f /etc/apt/sources.list.d/openresty.list",
      "apt-get update -qq && apt-get install -y -qq wget gnupg2 lsb-release",
      "wget -qO /tmp/openresty-pubkey.gpg https://openresty.org/package/pubkey.gpg",
      "gpg --yes --dearmor -o /usr/share/keyrings/openresty.gpg /tmp/openresty-pubkey.gpg",
      `REPO=${distro}`,
      ...OPENRESTY_APT_SOURCES,
      "apt-get update -qq && apt-get install -y -qq openresty",
    ].join("\n");
  } else if (profile.packageManager === "dnf") {
    const distro = profile.distro === "fedora" ? "fedora" : "centos";
    installCommand = `wget -qO /etc/yum.repos.d/openresty.repo https://openresty.org/package/${distro}/openresty.repo && dnf install -y openresty`;
  } else if (profile.packageManager === "yum") {
    installCommand = "wget -qO /etc/yum.repos.d/openresty.repo https://openresty.org/package/centos/openresty.repo && yum install -y openresty";
  } else if (profile.packageManager === "apk") {
    installCommand = [
      "apk add --no-cache wget",
      "wget -qO /etc/apk/keys/admin@openresty.com-5ea678a6.rsa.pub https://openresty.org/package/alpine/admin@openresty.com-5ea678a6.rsa.pub",
      `. /etc/os-release && echo "https://openresty.org/package/alpine/v$( echo $VERSION_ID | cut -d. -f1,2 )/main" >> /etc/apk/repositories`,
      "apk update && apk add openresty",
    ].join(" && ");
  } else {
    // No recognized package manager - probe at runtime.
    // The environment detection may have missed it (e.g. SSH session
    // didn't source /etc/profile), so try each one directly.
    installCommand = [
      "set -e",
      "if command -v apt-get >/dev/null 2>&1; then",
      "  rm -f /etc/apt/sources.list.d/openresty.list",
      "  apt-get update -qq && apt-get install -y -qq wget gnupg2 lsb-release",
      "  wget -qO /tmp/openresty-pubkey.gpg https://openresty.org/package/pubkey.gpg",
      "  gpg --yes --dearmor -o /usr/share/keyrings/openresty.gpg /tmp/openresty-pubkey.gpg",
      '  DISTRO=$(. /etc/os-release 2>/dev/null && echo "$ID" || echo "ubuntu")',
      '  case "$DISTRO" in debian) REPO=debian ;; *) REPO=ubuntu ;; esac',
      ...OPENRESTY_APT_SOURCES.map((l) => "  " + l),
      "  apt-get update -qq && apt-get install -y -qq openresty",
      "elif command -v dnf >/dev/null 2>&1; then",
      "  wget -qO /etc/yum.repos.d/openresty.repo https://openresty.org/package/centos/openresty.repo && dnf install -y openresty",
      "elif command -v yum >/dev/null 2>&1; then",
      "  wget -qO /etc/yum.repos.d/openresty.repo https://openresty.org/package/centos/openresty.repo && yum install -y openresty",
      "elif command -v apk >/dev/null 2>&1; then",
      "  apk add --no-cache wget \\",
      "  && wget -qO /etc/apk/keys/admin@openresty.com-5ea678a6.rsa.pub https://openresty.org/package/alpine/admin@openresty.com-5ea678a6.rsa.pub \\",
      '  && . /etc/os-release && echo "https://openresty.org/package/alpine/v$(echo $VERSION_ID | cut -d. -f1,2)/main" >> /etc/apk/repositories \\',
      "  && apk update && apk add openresty",
      "else",
      '  echo "No supported package manager found (tried apt-get, dnf, yum, apk)" >&2 && exit 1',
      "fi",
    ].join("\n");
  }

  return {
    supported: true,
    installCommand,
    startCommand:
      profile.serviceManager === "systemd"
        ? "systemctl enable openresty && systemctl start openresty"
        : undefined,
    verifyCommand: "openresty -v 2>&1",
  };
}

function certbotInstallPlan(profile: EnvironmentProfile): InstallPlan {
  const commands: Record<string, string> = {
    apt: "apt-get update -qq && apt-get install -y -qq certbot",
    dnf: "dnf install -y certbot",
    yum: "yum install -y certbot",
    apk: "apk add --no-cache certbot",
  };

  const installCommand = commands[profile.packageManager];
  if (!installCommand) {
    return {
      supported: false,
      unsupportedReason: "Certbot installation is only supported on Linux with apt, dnf, or yum",
    };
  }

  return {
    supported: true,
    installCommand,
    verifyCommand: "certbot --version 2>/dev/null",
  };
}

export const systemCatalog = {
  checks: {
    docker: {
      versionCommand: "docker --version",
      daemonCommand: "docker info --format '{{.ServerVersion}}'",
      parseVersion: (output: string) =>
        output.match(/Docker version ([^\s,]+)/)?.[1] ?? output,
      missingMessage: "Docker is not installed",
      notRunningMessage: "Docker is installed but the daemon is not running",
    },
    openresty: {
      versionCommand: "openresty -v 2>&1 || /usr/local/openresty/bin/openresty -v 2>&1",
      runningCommands: [
        "pgrep -f 'nginx.*openresty' || pgrep -f '/usr/local/openresty'",
      ],
      parseVersion: (output: string) =>
        output.match(/openresty\/(\S+)/)?.[1] ?? output.match(/nginx\/(\S+)/)?.[1] ?? output,
      missingMessage: "OpenResty is not installed",
      notRunningMessage: "OpenResty is installed but not running",
    },
    certbot: {
      versionCommand: "certbot --version 2>/dev/null",
      parseVersion: (output: string) => output.match(/certbot\s+(\S+)/)?.[1] ?? output,
      missingMessage: "Certbot is not installed",
    },
    git: {
      versionCommand: "git --version",
      parseVersion: (output: string) => output.match(/git version (\S+)/)?.[1] ?? output,
      missingMessage: "Git is not installed",
    },
    rsync: {
      versionCommand: "rsync --version | head -n 1",
      parseVersion: (output: string) => output.match(/rsync\s+version\s+(\S+)/i)?.[1] ?? output,
      missingMessage: "rsync is not installed",
    },
  },
  installs: {
    docker: dockerInstallPlan,
    git: gitInstallPlan,
    rsync: rsyncInstallPlan,
    openresty: openrestyInstallPlan,
    certbot: certbotInstallPlan,
  },
};