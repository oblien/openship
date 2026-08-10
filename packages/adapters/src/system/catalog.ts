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

export const systemCatalog = {
  checks: {
    docker: {
      versionCommand: "docker --version",
      // A POSITIVE signal, not a bare exit code: only a daemon that answered can
      // name its version. `docker info >/dev/null && echo ok` prints ok on ANY
      // exit-0, so a daemon answering nothing would read as healthy — trading #408's
      // false negative for a false positive. Leave stderr alone too; `checkDocker`
      // puts the failure text in the component message.
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
  // No `openresty` / `certbot` plans: nothing apt-installs an edge any more. Both
  // shipped inside the `openship-edge` image, and their host-package plans (with the
  // openresty.org apt-repo codename probing that came with them) went with the
  // installers. `checks.openresty` stays — it parses the version out of the
  // CONTAINER. See installer.ts `installContainerEdge`.
  installs: {
    docker: dockerInstallPlan,
    git: gitInstallPlan,
    rsync: rsyncInstallPlan,
  },
};