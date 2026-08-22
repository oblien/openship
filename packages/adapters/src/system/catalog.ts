import { answered, type Answer } from "@repo/core";

import type { EnvironmentProfile } from "./environment";
import { envOps, opScript } from "./environment-ops";

export interface ComponentCheckCatalogEntry {
  versionCommand: string;
  parseVersion: (output: string) => string;
  daemonCommand?: string;
  runningCommands?: string[];
  missingMessage: string;
  notRunningMessage?: string;
  /**
   * Headline for a daemon probe that was REFUSED rather than unanswered.
   *
   * Same verdict as `notRunningMessage`, opposite remedy — so they cannot be one
   * string. Absent means the component has no distinct denied case and falls back.
   */
  deniedMessage?: string;
}

/** What installing one component on one host takes. */
export interface ComponentInstall {
  /** Steps joined with `&&`, so a failed step aborts the rest. */
  readonly installCommand: string;
  /**
   * For a component with a daemon: how to start it here, or why we can't.
   *
   * Absent means the component *has* no service (git, rsync) — a fact about the
   * component. Present-and-refused means it has one and this host can't run it, which
   * the caller reports. The two used to be the same `startCommand: undefined`, which is
   * how Alpine installed Docker and never started it: the table only knew systemd.
   */
  readonly service?: Answer<string>;
  readonly verifyCommand: string;
}

export type InstallPlan = Answer<ComponentInstall>;

/**
 * The oldest Docker Engine Openship drives, and the floor an EXISTING install has
 * to clear for `installDocker` to leave it alone (#491).
 *
 * Deliberately a FLOOR, not "current". Openship never upgrades a working engine on
 * its own — restarting the daemon restarts every container on the host — so this is
 * only ever asked "is what's already here good enough", never "is it the latest".
 * 20.10 is where the surface the runtime depends on settled (cgroup v2 hosts,
 * `--restart`/healthcheck semantics, the inspect/exec formatting it parses), and
 * every distro that ships Docker at all ships something newer.
 */
export const MIN_DOCKER_VERSION = "20.10";

/**
 * Docker, the way this host installs it.
 *
 * `curl get.docker.com | sh` for everything was the origin bug: that script reads
 * os-release `ID` verbatim and hard-refuses `amzn`, `almalinux`, `ol` and `alpine`, so
 * the install "ran" and the box ended up with no dockerd — which the Docker-over-SSH
 * bridge then reported as `socket hang up`. `envOps` owns the per-family answer.
 */
function dockerInstallPlan(profile: EnvironmentProfile): InstallPlan {
  const ops = envOps(profile);
  const install = ops.dockerInstall();
  if (!install.supported) return install;

  const start = ops.dockerStart();
  return answered({
    installCommand: opScript(install.value),
    service: start.supported ? answered(opScript(start.value)) : start,
    verifyCommand: "docker --version",
  });
}

/** A component that is one package and one binary — no repo, no service. */
function packagePlan(
  profile: EnvironmentProfile,
  pkg: string,
  verifyCommand: string,
): InstallPlan {
  const install = envOps(profile).pkgInstall([pkg]);
  return install.supported
    ? answered({ installCommand: opScript(install.value), verifyCommand })
    : install;
}

export const systemCatalog = {
  checks: {
    docker: {
      versionCommand: "docker --version",
      // Docker 29 removed the `.ServerVersion` template field from `docker info`,
      // so `docker info --format '{{.ServerVersion}}'` fails with "no such field"
      // on healthy Docker 29+ daemons. `docker version --format '{{.Server.Version}}'`
      // is the documented, stable server-version probe across Docker 24-29+.
      daemonCommand: "docker version --format '{{.Server.Version}}'",
      parseVersion: (output: string) =>
        output.match(/Docker version ([^\s,]+)/)?.[1] ?? output,
      missingMessage: "Docker is not installed",
      notRunningMessage: "Docker is installed but the daemon is not running",
      // Deliberately does NOT claim the daemon is up or down: the socket's permission
      // is checked before the daemon is asked, so this arm proves only that we may not
      // ask. What it can state is the fix, which is the part "not running" got wrong.
      deniedMessage:
        "Docker is installed but this connection is not allowed to use its socket — " +
        "add the login user to the `docker` group, or connect as root",
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
    git: (profile: EnvironmentProfile) => packagePlan(profile, "git", "git --version"),
    rsync: (profile: EnvironmentProfile) =>
      packagePlan(profile, "rsync", "rsync --version | head -n 1"),
  },
};