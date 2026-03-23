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

function nginxInstallPlan(profile: EnvironmentProfile): InstallPlan {
  const commands: Record<string, string> = {
    apt: "apt-get update -qq && apt-get install -y -qq nginx certbot python3-certbot-nginx",
    dnf: "dnf install -y nginx certbot python3-certbot-nginx",
    yum: "yum install -y nginx certbot python3-certbot-nginx",
  };

  const installCommand = commands[profile.packageManager];
  if (!installCommand) {
    return {
      supported: false,
      unsupportedReason: "Nginx installation is only supported on Linux with apt, dnf, or yum",
    };
  }

  return {
    supported: true,
    installCommand,
    startCommand:
      profile.serviceManager === "systemd"
        ? "systemctl enable nginx && systemctl start nginx"
        : undefined,
    verifyCommand: "nginx -v 2>&1",
  };
}

function certbotInstallPlan(profile: EnvironmentProfile): InstallPlan {
  const commands: Record<string, string> = {
    apt: "apt-get update -qq && apt-get install -y -qq certbot python3-certbot-nginx",
    dnf: "dnf install -y certbot python3-certbot-nginx",
    yum: "yum install -y certbot python3-certbot-nginx",
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
    nginx: {
      versionCommand: "nginx -v 2>&1",
      runningCommands: [
        "pgrep -x nginx",
      ],
      parseVersion: (output: string) =>
        output.match(/nginx\/(\S+)/)?.[1] ?? output,
      missingMessage: "Nginx is not installed",
      notRunningMessage: "Nginx is installed but not running",
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
    nginx: nginxInstallPlan,
    certbot: certbotInstallPlan,
  },
};