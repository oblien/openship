import type { InstallerConfig } from "./types";
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

function nodeInstallPlan(profile: EnvironmentProfile): InstallPlan {
  if (profile.packageManager === "apt") {
    return {
      supported: true,
      installCommand:
        "curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && apt-get install -y nodejs",
      verifyCommand: "node --version",
    };
  }

  const fallbacks: Record<string, string> = {
    dnf: "dnf install -y nodejs",
    yum: "yum install -y nodejs",
    brew: "brew install node",
  };

  const fallback = fallbacks[profile.packageManager];
  if (!fallback) {
    return {
      supported: false,
      unsupportedReason: "No supported package manager found for Node.js installation",
    };
  }

  return {
    supported: true,
    installCommand: fallback,
    verifyCommand: "node --version",
  };
}

function traefikDockerPlan(
  _profile: EnvironmentProfile,
  config?: InstallerConfig,
): InstallPlan {
  const acmeEmail = config?.acmeEmail ?? "admin@localhost";
  const args = [
    "docker run -d",
    "--name traefik",
    "--restart unless-stopped",
    "--network host",
    "-v /var/run/docker.sock:/var/run/docker.sock:ro",
    "-v /etc/traefik:/etc/traefik",
    "traefik:v3.4",
    "--providers.file.directory=/etc/traefik/dynamic",
    "--providers.file.watch=true",
    "--entrypoints.web.address=:80",
    "--entrypoints.websecure.address=:443",
    `--certificatesresolvers.letsencrypt.acme.email=${acmeEmail}`,
    "--certificatesresolvers.letsencrypt.acme.storage=/etc/traefik/acme/acme.json",
    "--certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web",
  ];

  return {
    supported: true,
    installCommand: "docker pull traefik:v3.4",
    startCommand: args.join(" "),
    verifyCommand: "traefik version --format json 2>/dev/null || traefik version 2>/dev/null || echo unknown",
  };
}

function traefikBinaryPlan(profile: EnvironmentProfile): InstallPlan {
  if (profile.os !== "linux") {
    return {
      supported: false,
      unsupportedReason: "Traefik binary installation is only supported on Linux servers",
    };
  }

  const arch = profile.arch === "arm64" ? "arm64" : "amd64";
  const url = `https://github.com/traefik/traefik/releases/latest/download/traefik_linux_${arch}`;

  return {
    supported: true,
    installCommand:
      `curl -fsSL -o /tmp/traefik \"${url}\" && chmod +x /tmp/traefik && mv /tmp/traefik /usr/local/bin/traefik`,
    verifyCommand: "traefik version 2>/dev/null || echo unknown",
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
    traefik: {
      versionCommand: "traefik version --format json 2>/dev/null",
      runningCommands: [
        "pgrep -x traefik",
        "docker ps --filter name=traefik --format '{{.Names}}' 2>/dev/null",
      ],
      parseVersion: (output: string) => {
        try {
          return JSON.parse(output).Version;
        } catch {
          return output.match(/Version:\s*(\S+)/)?.[1] ?? output;
        }
      },
      missingMessage: "Traefik is not installed",
      notRunningMessage: "Traefik is installed but not running",
    },
    git: {
      versionCommand: "git --version",
      parseVersion: (output: string) => output.match(/git version (\S+)/)?.[1] ?? output,
      missingMessage: "Git is not installed",
    },
    node: {
      versionCommand: "node --version",
      parseVersion: (output: string) => output.replace(/^v/, ""),
      missingMessage: "Node.js is not installed",
    },
  },
  installs: {
    docker: dockerInstallPlan,
    git: gitInstallPlan,
    node: nodeInstallPlan,
    traefikDocker: traefikDockerPlan,
    traefikBinary: traefikBinaryPlan,
  },
};