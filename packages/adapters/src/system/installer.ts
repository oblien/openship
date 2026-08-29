/**
 * Component installers & uninstallers.
 *
 * Each component has a simple install/uninstall function. No shared
 * abstractions - each does exactly what it needs. All commands run
 * through CommandExecutor (SSH or local).
 */

import type { CommandExecutor, LogEntry } from "../types";
import type { InstallerConfig, InstallResult, SystemLogCallback, SystemLog } from "./types";
import { MIN_DOCKER_VERSION, systemCatalog } from "./catalog";
import { checkDocker } from "./checks";
import { resolveEnvironment, type EnvironmentProfile } from "./environment";
import { envOps, opScript } from "./environment-ops";
import { privilegedExecutor } from "./privilege";
import { answered, type Answer, compareSemver, safeErrorMessage } from "@repo/core";
import {
  EdgeMigrateRequested,
  invalidateEdgeContainer,
  resolveOurEdgeContainer,
} from "./proxy/detect";
import { probeListeningPort } from "../runtime/port-conflict";
import { dockerAvailable } from "./managed-image";
import { ensureContainerEdge } from "./proxy/ensure-container-edge";
import { containerCommand } from "./edge-container-executor";
import { sq } from "./local-shell";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(message: string, level: SystemLog["level"] = "info"): SystemLog {
  return { timestamp: new Date().toISOString(), message, level };
}

/** Run a command, swallow errors (best-effort). */
async function execSafe(executor: CommandExecutor, cmd: string): Promise<void> {
  try {
    await executor.exec(cmd);
  } catch {}
}

type ExecutorPrep =
  | { ok: true; executor: CommandExecutor; profile: EnvironmentProfile }
  | { ok: false; result: InstallResult };

/**
 * {@link privilegedExecutor} in this layer's own vocabulary — a refusal becomes the
 * `InstallResult` every caller here already returns. Call it BEFORE touching the box
 * (e.g. before stopping OpenResty), since running installs unelevated is the #84
 * apt-lock failure.
 */
async function prepareExecutor(
  executor: CommandExecutor,
  component: string,
): Promise<ExecutorPrep> {
  const grant = await privilegedExecutor(executor, `Installing ${component}`);
  if (!grant.supported) {
    return { ok: false, result: { component, success: false, error: grant.reason } };
  }
  return { ok: true, executor: grant.value.executor, profile: grant.value.profile };
}

/**
 * Turn a failed package install into something the operator can act on.
 *
 * "Docker install failed" named nothing — not the command, not the exit code, and
 * not the one line that carries the cause: apt's own `E: Held packages were changed
 * and -y was used without --allow-change-held-packages` (#491). It was visible only
 * by running the install by hand on the host. `streamExec` returns stdout AND
 * stderr, so the cause is already in hand; this picks the lines worth repeating and
 * caps them (installer output runs to hundreds of lines, and this string renders
 * inline in the UI).
 */
function describeInstallFailure(label: string, code: number, output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.replace(/\r/g, "").trim())
    .filter(Boolean);
  // apt/dpkg/dnf put the diagnosis on E:/Err:/Error:/dpkg: lines. Nothing matched →
  // the tail is the closest thing to a reason.
  const flagged = lines.filter((line) => /^(e:|err:|error:|dpkg:|fatal:)/i.test(line));
  const picked = (flagged.length ? flagged : lines).slice(-3).join(" · ");
  const detail = picked.length > 400 ? `${picked.slice(0, 399)}…` : picked;
  // The #491 host: the operator had held Docker's packages precisely so nothing
  // would upgrade them. A hold is a decision, not an obstacle — name it.
  const held = /held packages?|--allow-change-held-packages/i.test(output)
    ? " Packages are held on this host (`apt-mark hold`) and Openship does not override a hold — unhold them first if you do want this install."
    : "";
  return `${label} install failed (exit ${code})${detail ? `: ${detail}` : ""}.${held}`;
}

/** The package-manager remove command for this host, or the reason there isn't one. */
function removeCommand(profile: EnvironmentProfile, packages: string[]): Answer<string> {
  const remove = envOps(profile).pkgRemove(packages);
  return remove.supported ? answered(opScript(remove.value)) : remove;
}

// ─── Docker ──────────────────────────────────────────────────────────────────

/**
 * What Docker the box already has. Four answers, because three of them mean "do
 * NOT run the installer" — for three different reasons.
 */
interface DockerPresence {
  verdict: "missing" | "stopped" | "outdated" | "ok";
  version?: string;
  /** `checkDocker`'s message — carries the daemon's own refusal when there is one. */
  message: string;
}

/** Answered by the SHARED check, so "Docker is fine" means here exactly what it
 *  means on the Components tab. */
async function probeDocker(executor: CommandExecutor): Promise<DockerPresence> {
  const status = await checkDocker(executor);
  const version = status.version;
  if (!status.installed) return { verdict: "missing", message: status.message };
  if (!status.healthy) return { verdict: "stopped", version, message: status.message };
  if (version && compareSemver(version, MIN_DOCKER_VERSION) < 0) {
    return { verdict: "outdated", version, message: status.message };
  }
  return { verdict: "ok", version, message: status.message };
}

function dockerAlreadyThere(
  present: DockerPresence,
  onLog: SystemLogCallback,
): InstallResult {
  const named = present.version ? `Docker ${present.version}` : "Docker";
  onLog(log(`${named} is installed and its daemon is answering — nothing to install`));
  return { component: "docker", success: true, version: present.version };
}

/**
 * Install Docker Engine — but only on a box that actually needs it.
 *
 * #491: this used to run `get.docker.com` unconditionally, for every caller (the
 * mail wizard's "Ensure System Components" among them). On a host that already runs
 * Docker — including the host running Openship itself — that is not a no-op: the
 * installer pulls the CURRENT engine, which is a major upgrade (28.x → 29.x) plus
 * containerd, and restarting the daemon restarts every container on the box. An
 * operator who asked for a mail server got their whole stack bounced. An operator
 * who had pinned the packages against exactly that (`apt-mark hold`) got apt's
 * refusal reported as the self-contradictory "Docker install failed: Docker install
 * failed", on a box whose dashboard was demonstrably running under Docker.
 *
 * So the state of the host decides:
 *   ok       → return, having touched nothing (and without needing root)
 *   stopped  → start the daemon. Reinstalling cannot fix a daemon that isn't
 *              answering, and would upgrade the engine on the way past
 *   outdated → say what's needed and stop. An engine upgrade takes every container
 *              on the host down with it, so it is the operator's call, never a side
 *              effect of another flow happening to need Docker
 *   missing  → install
 *
 * `config.reinstall` is that operator's call (the Components tab's Reinstall
 * action) and the ONLY way to reach the installer over a working Docker.
 */
export async function installDocker(
  executor: CommandExecutor,
  onLog: SystemLogCallback,
  config?: InstallerConfig,
): Promise<InstallResult> {
  const forced = config?.reinstall === true;

  // Probe BEFORE elevating: skipping needs no root at all, and `prepareExecutor`
  // fails outright on a non-root box without sudo — which answered "installing
  // docker needs root" on hosts that needed no install in the first place.
  let present = forced ? null : await probeDocker(executor);
  if (present?.verdict === "ok") return dockerAlreadyThere(present, onLog);

  const prep = await prepareExecutor(executor, "docker");
  if (!prep.ok) return prep.result;
  executor = prep.executor;
  const profile = prep.profile;

  // A non-root user outside the `docker` group can't open the socket even when the
  // daemon is perfectly healthy, and from the probe that is indistinguishable from a
  // stopped daemon. Ask again as root before concluding anything.
  if (present && present.verdict !== "missing" && !profile.isRoot) {
    present = await probeDocker(executor);
    if (present.verdict === "ok") return dockerAlreadyThere(present, onLog);
  }

  const plan = systemCatalog.installs.docker(profile);
  // A host we can't install on still has to answer "how would I start it" — the
  // stopped-daemon branch below needs the reason, not an `undefined`.
  const service = plan.supported ? plan.value.service : plan;

  // Installed, current, daemon down → starting it IS the fix.
  if (present?.verdict === "stopped" && service?.supported) {
    onLog(log(`${present.message} — starting the Docker service`, "warn"));
    await executor
      .streamExec(service.value, onLog as (log: LogEntry) => void)
      .catch(() => undefined);
    present = await probeDocker(executor);
    if (present.verdict === "ok") {
      onLog(log(`Docker ${present.version} is running`));
      return { component: "docker", success: true, version: present.version };
    }
  }

  // Docker is here but not usable. Either way, running the installer now would be
  // an ENGINE UPGRADE with a daemon restart attached — the thing the operator has
  // to authorize. Say what's wrong instead of doing it.
  if (present && present.verdict !== "missing") {
    // Stopped AND unstartable is two facts, and the second one is the actionable
    // half — "start Docker and retry" is not advice on a host where we know why we
    // couldn't.
    const cannotStart =
      present.verdict === "stopped" && service && !service.supported
        ? ` Openship could not start it for you: ${service.reason}`
        : "";
    const error =
      (present.verdict === "outdated"
        ? `Docker ${present.version} is installed but Openship needs ${MIN_DOCKER_VERSION} or newer. ` +
          "Upgrading Docker restarts the daemon and every container on this server, so it is never done " +
          "as part of another step — upgrade it on the host, or use Reinstall on the Docker component to " +
          "run the official installer."
        : `${present.message}. Start Docker on this server and retry. Openship will not reinstall Docker ` +
          "over a daemon that is merely unreachable: the installer would also upgrade the engine and restart " +
          "every container on this host. Use Reinstall on the Docker component if that is what you want.") +
      cannotStart;
    onLog(log(error, "error"));
    return { component: "docker", success: false, version: present.version, error };
  }

  if (!plan.supported) {
    onLog(log(plan.reason, "error"));
    return { component: "docker", success: false, error: plan.reason };
  }

  onLog(
    forced
      ? log(
          "Running the Docker installer — it may upgrade the engine, which restarts the daemon and every container on this host...",
          "warn",
        )
      : log("Installing Docker Engine..."),
  );
  try {
    const { code, output } = await executor.streamExec(
      plan.value.installCommand,
      onLog as (log: LogEntry) => void,
    );
    if (code !== 0) {
      const error = describeInstallFailure("Docker", code, output);
      onLog(log(error, "error"));
      return { component: "docker", success: false, error };
    }

    if (service?.supported) {
      onLog(log("Starting Docker service..."));
      await executor.streamExec(service.value, onLog as (log: LogEntry) => void);
    } else if (service) {
      // How Alpine used to install Docker and never start it: the start table knew
      // only systemd, so "no command" and "no way to say so" were the same value.
      onLog(log(`Docker is installed but Openship cannot start it here: ${service.reason}`, "warn"));
    }

    const version = await executor.exec(plan.value.verifyCommand);
    const parsed = systemCatalog.checks.docker.parseVersion(version);
    onLog(log(`Docker ${parsed} installed`));
    return { component: "docker", success: true, version: parsed };
  } catch (err) {
    const msg = safeErrorMessage(err);
    onLog(log(`Docker installation failed: ${msg}`, "error"));
    return { component: "docker", success: false, error: msg };
  }
}

// ─── Git and rsync ───────────────────────────────────────────────────────────

/** A component that is one package and one binary — no repo, no daemon. */
type PackagedComponent = "git" | "rsync";

/**
 * Install one packaged component: plan, stream, verify, report.
 *
 * Git and rsync differed only in their operator-facing strings, and each carried
 * its own copy of this sequence — including its own way of turning a refused plan
 * into a message.
 */
async function installPackaged(
  executor: CommandExecutor,
  onLog: SystemLogCallback,
  component: PackagedComponent,
  label: string,
  /** Where it is going, when that isn't the host itself — a build container. */
  where?: string,
): Promise<InstallResult> {
  const prep = await prepareExecutor(executor, component);
  if (!prep.ok) return prep.result;
  executor = prep.executor;

  const plan = systemCatalog.installs[component](prep.profile);
  if (!plan.supported) {
    onLog(log(plan.reason, "error"));
    return { component, success: false, error: plan.reason };
  }
  const inside = where ? ` in ${where}` : "";

  onLog(log(`Installing ${label}${inside}...`));
  try {
    const { code, output } = await executor.streamExec(
      plan.value.installCommand,
      onLog as (log: LogEntry) => void,
    );
    if (code !== 0) {
      const error = describeInstallFailure(label, code, output);
      onLog(log(error, "error"));
      return { component, success: false, error };
    }

    const version = await executor.exec(plan.value.verifyCommand);
    const parsed = systemCatalog.checks[component].parseVersion(version);
    onLog(log(`${label} ${parsed} installed${inside}`));
    return { component, success: true, version: parsed };
  } catch (err) {
    const msg = safeErrorMessage(err);
    onLog(log(`${label} installation failed: ${msg}`, "error"));
    return { component, success: false, error: msg };
  }
}

export function installGit(
  executor: CommandExecutor,
  onLog: SystemLogCallback,
  opts?: { label?: string },
): Promise<InstallResult> {
  return installPackaged(executor, onLog, "git", "Git", opts?.label);
}

export function installRsync(
  executor: CommandExecutor,
  onLog: SystemLogCallback,
): Promise<InstallResult> {
  return installPackaged(executor, onLog, "rsync", "rsync");
}

/**
 * Install the edge — the `edge` component. It is a CONTAINER, always.
 *
 * The edge is the openship-edge image and its serving path is host-side (host
 * networking, host bind mounts for vhosts/certs/ACME). There is deliberately NO
 * host-package fallback: a Docker-less box gets an explicit, actionable failure
 * instead of a second, divergent edge implementation that then has to be migrated.
 *
 * THE only way to install an edge. There is no `installOpenResty`/`installCertbot`
 * any more — both apt-installed a host-side edge, and the mail wizard was the last
 * caller keeping them alive. That left one box able to end up with two edge
 * implementations, a certbot on the host that only mail's cert step used, and a
 * second copy of the conflict handling. `ensureContainerEdge` below still converts
 * a PRE-EXISTING host OpenResty (bare→container), which is how boxes installed
 * before this move come across.
 */
export async function installContainerEdge(
  executor: CommandExecutor,
  onLog: SystemLogCallback,
  config?: InstallerConfig,
): Promise<InstallResult> {
  // Elevate: `docker` may need sudo, and the host state dirs live under /var/lib
  // and /etc.
  const prep = await prepareExecutor(executor, "edge");
  if (!prep.ok) return prep.result;
  executor = prep.executor;

  if (!(await dockerAvailable(executor))) {
    const error =
      "The edge is a container image and needs Docker on this server. " +
      "Install the Docker component first, then install the edge.";
    onLog(log(error, "error"));
    return { component: "edge", success: false, error };
  }

  try {
    const result = await ensureContainerEdge(executor, {
      onLog,
      config,
      image: config?.edgeImage,
    });
    if (result.converted) {
      onLog(log("Edge moved from host OpenResty to the container edge", "warn"));
    }
    const version = await executor
      .exec(containerCommand(result.container, "openresty -v 2>&1"))
      .catch(() => "");
    return {
      component: "edge",
      success: true,
      version: version ? systemCatalog.checks.openresty.parseVersion(version) : undefined,
    };
  } catch (err) {
    // The migrate signal must reach the caller (which runs the takeover
    // orchestration) — don't swallow it into a failed InstallResult.
    if (err instanceof EdgeMigrateRequested) throw err;
    const msg = safeErrorMessage(err);
    onLog(log(`Edge setup failed: ${msg}`, "error"));
    return { component: "edge", success: false, error: msg };
  }
}

// ─── Uninstallers ────────────────────────────────────────────────────────────

export async function uninstallRsync(
  executor: CommandExecutor,
  onLog: SystemLogCallback,
): Promise<InstallResult> {
  const prep = await prepareExecutor(executor, "rsync");
  if (!prep.ok) return prep.result;
  executor = prep.executor;
  const cmd = removeCommand(prep.profile, ["rsync"]);
  if (!cmd.supported) {
    onLog(log(cmd.reason, "error"));
    return { component: "rsync", success: false, error: cmd.reason };
  }

  onLog(log("Removing rsync..."));
  try {
    const { code } = await executor.streamExec(cmd.value, onLog as (log: LogEntry) => void);
    if (code !== 0) return { component: "rsync", success: false, error: "rsync removal failed" };
    onLog(log("rsync removed"));
    return { component: "rsync", success: true };
  } catch (err) {
    const msg = safeErrorMessage(err);
    return { component: "rsync", success: false, error: msg };
  }
}

export async function uninstallEdge(
  executor: CommandExecutor,
  onLog: SystemLogCallback,
): Promise<InstallResult> {
  const prep = await prepareExecutor(executor, "edge");
  if (!prep.ok) return prep.result;
  executor = prep.executor;

  // `fresh`: we are about to REMOVE it, so a stale positive would `docker rm` a
  // name that no longer exists and report success over an untouched box.
  const container = await resolveOurEdgeContainer(executor, { fresh: true }).catch(() => null);
  if (!container) {
    onLog(log("No edge container on this server — nothing to remove."));
    return { component: "edge", success: true };
  }

  onLog(log(`Removing the edge container ${container}...`));
  // Clear the restart policy first, or the daemon brings it straight back.
  await execSafe(executor, `docker update --restart=no ${sq(container)} 2>/dev/null || true`);
  await execSafe(executor, `docker rm -f ${sq(container)} 2>/dev/null || true`);
  invalidateEdgeContainer(executor);
  // Certs and vhosts stay on the host on purpose — same rule as the compose
  // uninstall: issued certificates outlive a reinstall, and /etc/letsencrypt may be
  // shared with the mail server. Removing them is the operator's call.
  onLog(log("Edge removed. Certificates and vhosts were left on the host."));
  return { component: "edge", success: true };
}

// ─── Removal support check ──────────────────────────────────────────────────

export async function getRemovalSupport(
  executor: CommandExecutor,
  componentName: string,
): Promise<{ supported: boolean; reason?: string }> {
  // The edge is a container: removal needs the daemon, not a package manager.
  if (componentName === "edge") return { supported: true };
  const profile = await resolveEnvironment(executor);
  const cmd = removeCommand(profile, [componentName]);
  return cmd.supported ? { supported: true } : { supported: false, reason: cmd.reason };
}

// ─── Registry ────────────────────────────────────────────────────────────────

type InstallerFn = (
  executor: CommandExecutor,
  onLog: SystemLogCallback,
  config?: InstallerConfig,
) => Promise<InstallResult>;

export const COMPONENT_INSTALLERS: Record<string, InstallerFn> = {
  docker: (exec, log, config) => installDocker(exec, log, config),
  // The edge is ONE component and it is a container image — there is no
  // host-OpenResty or host-certbot installer to reach for any more.
  edge: (exec, log, config) => installContainerEdge(exec, log, config),
  git: (exec, log) => installGit(exec, log),
  rsync: (exec, log) => installRsync(exec, log),
};

export const COMPONENT_UNINSTALLERS: Record<string, InstallerFn> = {
  edge: (exec, log) => uninstallEdge(exec, log),
  rsync: (exec, log) => uninstallRsync(exec, log),
};
