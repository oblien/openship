/**
 * Toolchain catalog — check recipes + install plan factories.
 *
 * Same pattern as system/catalog.ts:
 *   - `checks` → recipes for detecting tools (versionCommand, parseVersion)
 *   - `installs` → factory functions that return install plans per-OS
 *
 * OS-awareness lives in the install plan factories via EnvironmentProfile.
 * The catalog itself is universal.
 */

import type { EnvironmentProfile } from "../system/environment";
import type { ToolchainCheckEntry, ToolchainInstallPlan } from "./types";

// ─── Install plan factories ─────────────────────────────────────────────────

function nodeInstallPlan(profile: EnvironmentProfile): ToolchainInstallPlan {
  if (profile.os === "linux" && ["apt", "dnf", "yum"].includes(profile.packageManager)) {
    const installCommands: Record<string, string> = {
      apt: "curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && apt-get install -y nodejs",
      dnf: "curl -fsSL https://rpm.nodesource.com/setup_lts.x | bash - && dnf install -y nodejs",
      yum: "curl -fsSL https://rpm.nodesource.com/setup_lts.x | bash - && yum install -y nodejs",
    };
    return {
      supported: true,
      installCommand: installCommands[profile.packageManager],
      verifyCommand: "node --version",
    };
  }

  const fallbacks: Record<string, string> = {
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

function goInstallPlan(profile: EnvironmentProfile): ToolchainInstallPlan {
  if (profile.os === "linux") {
    const arch = profile.arch === "arm64" ? "arm64" : "amd64";
    return {
      supported: true,
      installCommand: [
        `curl -fsSL https://go.dev/dl/go1.22.5.linux-${arch}.tar.gz -o /tmp/go.tar.gz`,
        "rm -rf /usr/local/go",
        "tar -C /usr/local -xzf /tmp/go.tar.gz",
        "rm /tmp/go.tar.gz",
        'echo \'export PATH=$PATH:/usr/local/go/bin\' >> /etc/profile.d/go.sh',
        "export PATH=$PATH:/usr/local/go/bin",
      ].join(" && "),
      verifyCommand: "/usr/local/go/bin/go version || go version",
    };
  }

  if (profile.packageManager === "brew") {
    return {
      supported: true,
      installCommand: "brew install go",
      verifyCommand: "go version",
    };
  }

  return {
    supported: false,
    unsupportedReason: "Go installation is only supported on Linux and macOS (brew)",
  };
}

function rustInstallPlan(_profile: EnvironmentProfile): ToolchainInstallPlan {
  return {
    supported: true,
    installCommand:
      "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && . $HOME/.cargo/env",
    verifyCommand: ". $HOME/.cargo/env && rustc --version",
  };
}

function pythonInstallPlan(profile: EnvironmentProfile): ToolchainInstallPlan {
  const commands: Record<string, string> = {
    apt: "apt-get update -qq && apt-get install -y -qq python3 python3-pip python3-venv",
    dnf: "dnf install -y python3 python3-pip",
    yum: "yum install -y python3 python3-pip",
    brew: "brew install python3",
  };

  const installCommand = commands[profile.packageManager];
  if (!installCommand) {
    return {
      supported: false,
      unsupportedReason: "No supported package manager found for Python installation",
    };
  }

  return {
    supported: true,
    installCommand,
    verifyCommand: "python3 --version",
  };
}

function rubyInstallPlan(profile: EnvironmentProfile): ToolchainInstallPlan {
  const commands: Record<string, string> = {
    apt: "apt-get update -qq && apt-get install -y -qq ruby-full build-essential",
    dnf: "dnf install -y ruby ruby-devel",
    yum: "yum install -y ruby ruby-devel",
    brew: "brew install ruby",
  };

  const installCommand = commands[profile.packageManager];
  if (!installCommand) {
    return {
      supported: false,
      unsupportedReason: "No supported package manager found for Ruby installation",
    };
  }

  return {
    supported: true,
    installCommand,
    verifyCommand: "ruby --version",
  };
}

function phpInstallPlan(profile: EnvironmentProfile): ToolchainInstallPlan {
  if (profile.packageManager === "apt") {
    return {
      supported: true,
      installCommand: [
        "apt-get update -qq",
        "apt-get install -y -qq php-cli php-mbstring php-xml php-curl unzip",
        "curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer",
      ].join(" && "),
      verifyCommand: "php --version && composer --version",
    };
  }

  const commands: Record<string, string> = {
    dnf: "dnf install -y php-cli php-mbstring php-xml php-curl composer",
    yum: "yum install -y php-cli php-mbstring php-xml php-curl",
    brew: "brew install php composer",
  };

  const installCommand = commands[profile.packageManager];
  if (!installCommand) {
    return {
      supported: false,
      unsupportedReason: "No supported package manager found for PHP installation",
    };
  }

  return {
    supported: true,
    installCommand,
    verifyCommand: "php --version",
  };
}

function javaInstallPlan(profile: EnvironmentProfile): ToolchainInstallPlan {
  const commands: Record<string, string> = {
    apt: "apt-get update -qq && apt-get install -y -qq openjdk-21-jdk",
    dnf: "dnf install -y java-21-openjdk-devel",
    yum: "yum install -y java-21-openjdk-devel",
    brew: "brew install openjdk@21",
  };

  const installCommand = commands[profile.packageManager];
  if (!installCommand) {
    return {
      supported: false,
      unsupportedReason: "No supported package manager found for Java installation",
    };
  }

  return {
    supported: true,
    installCommand,
    verifyCommand: "java --version 2>&1",
  };
}

function dotnetInstallPlan(profile: EnvironmentProfile): ToolchainInstallPlan {
  if (profile.os === "linux") {
    return {
      supported: true,
      installCommand:
        "curl -fsSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 8.0 --install-dir /usr/local/share/dotnet && ln -sf /usr/local/share/dotnet/dotnet /usr/local/bin/dotnet",
      verifyCommand: "dotnet --version",
    };
  }

  if (profile.packageManager === "brew") {
    return {
      supported: true,
      installCommand: "brew install dotnet-sdk",
      verifyCommand: "dotnet --version",
    };
  }

  return {
    supported: false,
    unsupportedReason: ".NET SDK installation is only supported on Linux and macOS (brew)",
  };
}

function elixirInstallPlan(profile: EnvironmentProfile): ToolchainInstallPlan {
  const commands: Record<string, string> = {
    apt: "apt-get update -qq && apt-get install -y -qq erlang elixir",
    dnf: "dnf install -y erlang elixir",
    brew: "brew install elixir",
  };

  const installCommand = commands[profile.packageManager];
  if (!installCommand) {
    return {
      supported: false,
      unsupportedReason: "No supported package manager found for Elixir installation",
    };
  }

  return {
    supported: true,
    installCommand,
    verifyCommand: "elixir --version",
  };
}

function bundlerInstallPlan(_profile: EnvironmentProfile): ToolchainInstallPlan {
  return {
    supported: true,
    installCommand: "gem install bundler",
    verifyCommand: "bundler --version",
  };
}

function composerInstallPlan(profile: EnvironmentProfile): ToolchainInstallPlan {
  if (profile.packageManager === "brew") {
    return {
      supported: true,
      installCommand: "brew install composer",
      verifyCommand: "composer --version",
    };
  }

  return {
    supported: true,
    installCommand:
      "curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer",
    verifyCommand: "composer --version",
  };
}

function pipInstallPlan(profile: EnvironmentProfile): ToolchainInstallPlan {
  const commands: Record<string, string> = {
    apt: "apt-get update -qq && apt-get install -y -qq python3-pip",
    dnf: "dnf install -y python3-pip",
    yum: "yum install -y python3-pip",
    brew: "python3 -m ensurepip --upgrade",
  };

  const installCommand = commands[profile.packageManager];
  if (!installCommand) {
    return {
      supported: false,
      unsupportedReason: "No supported package manager found for pip installation",
    };
  }

  return {
    supported: true,
    installCommand,
    verifyCommand: "pip3 --version || pip --version",
  };
}

// ─── The catalog ─────────────────────────────────────────────────────────────

type InstallPlanFactory = (profile: EnvironmentProfile) => ToolchainInstallPlan;

export const toolchainCatalog = {
  /**
   * Check recipes — how to detect each tool and parse its version.
   *
   * Every tool in LANGUAGES[lang].requiredTools must have an entry here.
   */
  checks: {
    node: {
      label: "Node.js",
      versionCommand: "node --version",
      parseVersion: (output: string) => output.replace(/^v/, "").trim(),
      missingMessage: "Node.js is not installed",
      installable: true,
    },
    npm: {
      label: "npm",
      versionCommand: "npm --version",
      parseVersion: (output: string) => output.trim(),
      missingMessage: "npm is not installed",
      installable: false,
      providedBy: "node",
    },
    go: {
      label: "Go",
      versionCommand: "go version",
      parseVersion: (output: string) => output.match(/go(\d+\.\d+(\.\d+)?)/)?.[1] ?? output.trim(),
      missingMessage: "Go is not installed",
      installable: true,
    },
    rustc: {
      label: "Rust compiler",
      versionCommand: "rustc --version",
      parseVersion: (output: string) => output.match(/rustc (\S+)/)?.[1] ?? output.trim(),
      missingMessage: "Rust compiler is not installed",
      installable: true,
    },
    cargo: {
      label: "Cargo",
      versionCommand: "cargo --version",
      parseVersion: (output: string) => output.match(/cargo (\S+)/)?.[1] ?? output.trim(),
      missingMessage: "Cargo is not installed",
      installable: false,
      providedBy: "rustc",
    },
    python3: {
      label: "Python 3",
      versionCommand: "python3 --version",
      parseVersion: (output: string) => output.match(/Python (\S+)/)?.[1] ?? output.trim(),
      missingMessage: "Python 3 is not installed",
      installable: true,
    },
    pip: {
      label: "pip",
      versionCommand: "pip3 --version || pip --version",
      parseVersion: (output: string) => output.match(/pip (\S+)/)?.[1] ?? output.trim(),
      missingMessage: "pip is not installed",
      installable: true,
      providedBy: "python3",
    },
    ruby: {
      label: "Ruby",
      versionCommand: "ruby --version",
      parseVersion: (output: string) => output.match(/ruby (\S+)/)?.[1] ?? output.trim(),
      missingMessage: "Ruby is not installed",
      installable: true,
    },
    bundler: {
      label: "Bundler",
      versionCommand: "bundler --version",
      parseVersion: (output: string) => output.match(/(\d+\.\d+\.\d+)/)?.[1] ?? output.trim(),
      missingMessage: "Bundler is not installed",
      installable: true,
      providedBy: "ruby",
    },
    php: {
      label: "PHP",
      versionCommand: "php --version",
      parseVersion: (output: string) => output.match(/PHP (\S+)/)?.[1] ?? output.trim(),
      missingMessage: "PHP is not installed",
      installable: true,
    },
    composer: {
      label: "Composer",
      versionCommand: "composer --version",
      parseVersion: (output: string) => output.match(/(\d+\.\d+\.\d+)/)?.[1] ?? output.trim(),
      missingMessage: "Composer is not installed",
      installable: true,
      providedBy: "php",
    },
    java: {
      label: "Java",
      versionCommand: "java --version 2>&1 || java -version 2>&1",
      parseVersion: (output: string) => output.match(/(\d+\.\d+)/)?.[1] ?? output.trim(),
      missingMessage: "Java is not installed",
      installable: true,
    },
    javac: {
      label: "Java compiler",
      versionCommand: "javac --version 2>&1 || javac -version 2>&1",
      parseVersion: (output: string) => output.match(/javac (\S+)/)?.[1] ?? output.trim(),
      missingMessage: "Java compiler (javac) is not installed",
      installable: false,
      providedBy: "java",
    },
    dotnet: {
      label: ".NET SDK",
      versionCommand: "dotnet --version",
      parseVersion: (output: string) => output.trim(),
      missingMessage: ".NET SDK is not installed",
      installable: true,
    },
    elixir: {
      label: "Elixir",
      versionCommand: "elixir --version 2>&1",
      parseVersion: (output: string) => output.match(/Elixir (\S+)/)?.[1] ?? output.trim(),
      missingMessage: "Elixir is not installed",
      installable: true,
    },
    mix: {
      label: "Mix",
      versionCommand: "mix --version 2>&1",
      parseVersion: (output: string) => output.match(/Mix (\S+)/)?.[1] ?? output.trim(),
      missingMessage: "Mix is not installed",
      installable: false,
      providedBy: "elixir",
    },
  } as Record<string, ToolchainCheckEntry>,

  /**
   * Install plan factories — how to install each tool on a given OS.
   *
   * Only tools with `installable: true` (and no `providedBy`) need an entry.
   * Tools like npm, cargo, mix are installed as part of their parent.
   */
  installs: {
    node: nodeInstallPlan,
    go: goInstallPlan,
    rustc: rustInstallPlan,
    python3: pythonInstallPlan,
    pip: pipInstallPlan,
    ruby: rubyInstallPlan,
    bundler: bundlerInstallPlan,
    php: phpInstallPlan,
    composer: composerInstallPlan,
    java: javaInstallPlan,
    dotnet: dotnetInstallPlan,
    elixir: elixirInstallPlan,
  } as Record<string, InstallPlanFactory>,
};
