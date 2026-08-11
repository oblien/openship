/**
 * Bring up OUR edge as a CONTAINER on any box — the single installed edge path.
 *
 * Replaces apt-installing OpenResty + certbot and templating nginx.conf/Lua onto
 * the host: `apps/edge` bakes a complete config, the Openship Lua and certbot into
 * one multi-arch image, so the edge becomes a versioned artifact pinned to the
 * release instead of a package-manager outcome that drifts per distro and arch.
 *
 * State lives at canonical HOST paths bind-mounted in (EDGE_CONTAINER_MOUNTS), so
 * `/etc/letsencrypt` stays exactly where the rest of the system already reads it
 * and a bare→container conversion inherits the box's existing certs.
 *
 * Converting a box that is CURRENTLY SERVING is the risky part, so the order is
 * chosen to keep it serving: pull before anything stops, copy vhosts before the
 * cutover, and roll all the way back to the host OpenResty if the container
 * doesn't come up.
 */

import { buildEdgeImageRef, safeErrorMessage } from "@repo/core";
import type { CommandExecutor, LogEntry } from "../../types";
import type { NginxProvider, NginxProviderOptions } from "../../infra/nginx";
import type { InstallerConfig, SystemLog, SystemLogCallback } from "../types";
import {
  EDGE_CONTAINER_MOUNTS,
  EDGE_HOST_PATHS,
  detectOpenRestyPaths,
  OPENRESTY_DEFAULT_PATHS,
} from "../../infra/openresty-lua";
import { sq } from "../local-shell";
import { containerCommand, edgeContainerExecutor } from "../edge-container-executor";
import { waitForPortListening } from "../port-listen";
import {
  EDGE_CONTAINER_NAME,
  edgeFailureReason,
  sanitizeEdgeVhosts,
  invalidateEdgeContainer,
  ourLuaOnHost,
  resolveOurEdgeContainer,
} from "./detect";
import { ensureEdgeClear } from "./consent";

function log(message: string, level: SystemLog["level"] = "info"): SystemLog {
  return { timestamp: new Date().toISOString(), message, level };
}

// The image to use when a call site passes none. The API injects its own pinned
// ref once at boot (setDefaultEdgeImage) — mirroring setBackupCredentialSecret —
// because this package can't compute it: the pin is derived from APP_VERSION, which
// lives in apps/api/package.json.
//
// This exists because a `:latest` fallback made FORGETTING to pin silent. Two call
// paths did forget (the takeover's unset `edgeImage`, and the deploy platform's
// never-populated `installerConfig`), and both quietly installed an edge whose baked
// Lua could skew from the API driving it — the exact failure the pin prevents. Now
// the default is correct even when a caller says nothing.
let injectedDefaultImage: string | undefined;

/** Inject the API-resolved pinned edge image. Call once at app boot. */
export function setDefaultEdgeImage(image: string | undefined): void {
  injectedDefaultImage = image?.trim() || undefined;
}

/**
 * The edge image to run — the API-side consumer of the shared precedence.
 *
 * Delegates to `buildEdgeImageRef` (@repo/core) so this and the API's
 * `pinnedEdgeImage` can't diverge (they used to disagree on `OPENSHIP_EDGE_TAG`).
 * The `injectedDefault` slot is this layer's version source: the API injects its
 * APP_VERSION-pinned ref at boot via `setDefaultEdgeImage`, keeping the edge's baked
 * Lua == the API build. With no injection (bare adapters consumer, tests) it falls
 * through to the registry + `OPENSHIP_VERSION`/`:latest` tail.
 */
export function resolveEdgeImage(explicit?: string): string {
  return buildEdgeImageRef({ explicit, injectedDefault: injectedDefaultImage });
}

export interface ContainerEdgeResult {
  container: string;
  image: string;
  /** True when this call converted a bare host OpenResty into the container. */
  converted: boolean;
  /** True when this call replaced a running edge with a different image. */
  updated?: boolean;
  /**
   * An image swap failed AND its rollback failed — this box has NO edge serving.
   *
   * Distinct from `updated: false`, which is also what "already on the right image"
   * returns. Without this flag the two are indistinguishable to a caller, so the
   * worst outcome this function has (every domain on the box now 502s) was visible
   * only as a log line inside a deploy's output.
   */
  edgeDown?: boolean;
}

/** Is Docker usable on this box? The container edge needs it; a bare edge doesn't. */
export async function dockerAvailable(executor: CommandExecutor): Promise<boolean> {
  return executor
    .exec("docker version --format '{{.Server.Version}}' 2>/dev/null")
    .then((v) => Boolean(v.trim()))
    .catch(() => false);
}

/** The image ref a running container was created from. */
async function runningImage(
  executor: CommandExecutor,
  container: string,
): Promise<string | null> {
  const out = await executor
    .exec(`docker inspect -f '{{.Config.Image}}' ${sq(container)} 2>/dev/null`)
    .catch(() => "");
  return out.trim() || null;
}

/**
 * Options a caller may pass through to the underlying NginxProvider. `executor`,
 * `paths` and `pinPaths` are decided HERE and are deliberately not overridable —
 * they're the whole point of these two builders.
 */
export type EdgeProviderOptions = Omit<
  NginxProviderOptions,
  "executor" | "paths" | "pinPaths" | "containerEdge"
>;

/**
 * Build the routing/SSL provider for a box whose edge is a CONTAINER reached from
 * outside it (over SSH). Shared by the deploy platform and the foreign-proxy
 * takeover so the path/pin decision is made in exactly one place — making it twice
 * is what silently pointed vhost writes at a directory nothing served from.
 */
export async function containerEdgeProvider(
  executor: CommandExecutor,
  container: string,
  opts?: EdgeProviderOptions,
): Promise<NginxProvider> {
  const { NginxProvider: Provider } = await import("../../infra/nginx");
  return new Provider({
    ...opts,
    // Vhosts go to the BIND-MOUNTED HOST dir (so every host-side reader — the
    // migrate proxy scan, cert reuse, the mail cert symlinks — keeps working),
    // while reload/certbot run inside the container.
    paths: EDGE_HOST_PATHS,
    executor: edgeContainerExecutor(executor, container),
    // MUST be pinned: re-detection answers from inside the container and would
    // repoint sitesDir at a host dir the edge never reads.
    pinPaths: true,
    // Reload runs INSIDE the container, where the master is pid 1 — so a failed
    // reload must never fall back to killing it (#292).
    containerEdge: true,
  });
}

/**
 * Same edge, reached the OTHER way: the api process shares the routing mounts with
 * the edge container on its own box (compose), so it writes vhosts through its own
 * filesystem and reloads / runs certbot via `docker exec` on the mounted socket.
 *
 * Paths are the CONTAINER's, not `EDGE_HOST_PATHS` — the mounts land the same files
 * at the same place from both sides. Lives next to `containerEdgeProvider` on
 * purpose: these two are the only pinned-path constructions in the codebase, and
 * splitting them across files is how they drifted the first time.
 */
export async function localContainerEdgeProvider(
  container: string,
  opts?: EdgeProviderOptions,
): Promise<NginxProvider> {
  const { DockerEdgeExecutor } = await import("../docker-edge-executor");
  const { NginxProvider: Provider } = await import("../../infra/nginx");
  return new Provider({
    ...opts,
    paths: OPENRESTY_DEFAULT_PATHS,
    executor: new DockerEdgeExecutor({ containerName: container }),
    // nginx.conf + the Lua are BAKED into the image — nothing to detect, install
    // or patch, and detection would answer from inside the container anyway.
    pinPaths: true,
    // `docker exec`s into the edge, so the master is pid 1 there too (#292).
    containerEdge: true,
  });
}

export interface ContainerEdgeOptions {
  onLog: SystemLogCallback;
  /** Explicit image ref; see {@link resolveEdgeImage}. */
  image?: string;
  /** Consent + takeover policy for a FOREIGN proxy on 80/443. */
  config?: InstallerConfig;
  container?: string;
  /** How long to wait for :80 before calling the start a failure. */
  verifyTimeoutMs?: number;
}

/**
 * The ONLY way this module starts the edge container.
 *
 * Every start sanitizes the vhost dir it is about to mount first — not because the
 * caller might have carried something bad, but because the dir is HOST state that
 * outlives every container. One conf left there by an older version (or a hand
 * edit) crash-loops the edge with `[emerg] a duplicate default server`, forever,
 * on every start by anyone. Guarding the callers instead of the start is how the
 * image-swap path and the compose path each shipped without it.
 *
 * `docker rm -f` first: a stopped/renamed leftover holds the name and `docker run`
 * would fail on it.
 */
async function startEdgeContainer(
  executor: CommandExecutor,
  container: string,
  image: string,
  onLog: SystemLogCallback,
): Promise<boolean> {
  await sanitizeEdgeVhosts(executor, EDGE_HOST_PATHS.sitesDir, onLog).catch(() => {});
  await executor.exec(`docker rm -f ${sq(container)} 2>/dev/null || true`).catch(() => {});
  const run = await executor.streamExec(
    buildEdgeRunCommand(container, image),
    onLog as (l: LogEntry) => void,
  );
  // Identity just changed; nobody may keep answering from a pre-start memo.
  invalidateEdgeContainer(executor);
  return run.code === 0;
}

/** `docker run` argv for the edge: host networking (it owns 80/443) + the mounts. */
export function buildEdgeRunCommand(container: string, image: string): string {
  const mounts = EDGE_CONTAINER_MOUNTS.map(
    // `:z` relabels for SELinux-enforcing hosts; a no-op elsewhere.
    (m) => `-v ${sq(`${m.host}:${m.container}:z`)}`,
  ).join(" ");
  return [
    "docker run -d",
    `--name ${sq(container)}`,
    "--network host",
    "--restart unless-stopped",
    mounts,
    sq(image),
  ].join(" ");
}

/**
 * Move a running edge onto a new image: pull, recreate, verify — and put the OLD
 * image back if the new one doesn't come up.
 *
 * Same ordering rule as the bare→container conversion: nothing is torn down until
 * the replacement is on the box. Best-effort by design — a failed update must leave
 * the edge serving, so it logs and reports false rather than throwing.
 */
async function swapEdgeImage(
  executor: CommandExecutor,
  container: string,
  from: string,
  to: string,
  opts: ContainerEdgeOptions,
): Promise<{ swapped: boolean; edgeDown: boolean }> {
  const { onLog } = opts;
  onLog(log(`Updating the edge: ${from} → ${to}`));
  const pull = await executor.streamExec(`docker pull ${sq(to)}`, onLog as (l: LogEntry) => void);
  if (pull.code !== 0) {
    // Nothing was torn down yet — the old edge is still serving.
    onLog(log(`Could not pull ${to} — the edge stays on ${from}.`, "warn"));
    return { swapped: false, edgeDown: false };
  }

  const start = async (image: string) => {
    if (!(await startEdgeContainer(executor, container, image, onLog))) return false;
    const listening = await waitForPortListening(executor, 80, {
      timeoutMs: opts.verifyTimeoutMs ?? 30_000,
    });
    return !(listening.checked && !listening.listening);
  };

  if (await start(to)) {
    onLog(log(`Edge updated to ${to}`));
    return { swapped: true, edgeDown: false };
  }

  onLog(log(`Edge ${to} failed to come up — rolling back to ${from}...`, "error"));
  if (await start(from)) {
    // Rolled back cleanly: not updated, but still serving on the old image.
    return { swapped: false, edgeDown: false };
  }
  // Both failed: say so loudly AND report it. The box is now without an edge, and
  // that must not be discoverable only by a user noticing a 502.
  onLog(log(`Rollback to ${from} ALSO failed — the edge is down on this server.`, "error"));
  return { swapped: false, edgeDown: true };
}

/** Entry names in a directory, or null when it can't be listed. */
async function listDir(
  executor: CommandExecutor,
  dir: string,
): Promise<Set<string>> {
  const out = await executor.exec(`ls -1 ${sq(dir)} 2>/dev/null || true`).catch(() => "");
  return new Set(
    out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

/**
 * Idempotent: returns early when our edge container is already running on the
 * pinned image (and updates it in place when it isn't).
 *
 * Throws on failure (including `EdgeMigrateRequested` / `EdgeConflictError` from
 * the unchanged foreign-proxy consent path) — after restoring whatever was
 * serving before.
 */
export async function ensureContainerEdge(
  executor: CommandExecutor,
  opts: ContainerEdgeOptions,
): Promise<ContainerEdgeResult> {
  const { onLog } = opts;
  const container = opts.container?.trim() || EDGE_CONTAINER_NAME;
  const image = resolveEdgeImage(opts.image);

  // `fresh`: this call decides whether to CREATE an edge. A memo saying "yes" when
  // the container is gone skips the install and leaves the box with no proxy.
  const existing = await resolveOurEdgeContainer(executor, { fresh: true });
  if (existing) {
    // Already ours. The only thing left to reconcile is the IMAGE: the edge's Lua
    // and nginx.conf are baked in, so an edge left on an old tag keeps serving
    // rules a newer API assumes it rewrote. Upgrading the API upgrades the edge.
    const current = await runningImage(executor, existing);
    if (current && current !== image) {
      const swap = await swapEdgeImage(executor, existing, current, image, opts);
      return {
        container: existing,
        image,
        converted: false,
        updated: swap.swapped,
        edgeDown: swap.edgeDown,
      };
    }
    return { container: existing, image, converted: false };
  }

  // Foreign proxy on 80/443 → unchanged consent/takeover gate. Runs BEFORE we
  // touch anything, exactly as the bare installer did.
  await ensureEdgeClear(executor, opts.config, onLog);

  if (!(await dockerAvailable(executor))) {
    throw new Error(
      "Docker isn't available on this server, and the edge now runs as a container. " +
        "Install the Docker component first, then set up the edge.",
    );
  }

  // Capture this BEFORE stopping anything: it decides both whether we migrate
  // vhosts across and whether a rollback has something to restore.
  const bareWasOurs = await ourLuaOnHost(executor);

  // 1. Pull first. A registry failure must land here, while the current edge is
  //    still serving — this is the one failure mode that would otherwise leave a
  //    live box with no proxy.
  onLog(log(`Pulling edge image ${image}...`));
  const pull = await executor.streamExec(`docker pull ${sq(image)}`, onLog as (l: LogEntry) => void);
  if (pull.code !== 0) {
    throw new Error(
      `Could not pull the edge image ${image} — the box is unchanged and still serving. ` +
        "Check the server's network access to the registry, then retry.",
    );
  }

  // 2. Host state dirs.
  for (const mount of EDGE_CONTAINER_MOUNTS) {
    await executor.exec(`mkdir -p ${sq(mount.host)}`).catch(() => {});
  }

  // 3. Carry existing vhosts over. They reference the Lua at the same absolute
  //    path the image bakes it to, and certs at the bind-mounted /etc/letsencrypt,
  //    so a plain copy keeps every served domain intact.
  const sitesTarget = EDGE_HOST_PATHS.sitesDir;
  // What was in the target BEFORE the carry. null = we never looked, so the
  // rollback must not delete anything (fail safe — never guess at removals in a
  // directory the edge serves from).
  let beforeCarry: Set<string> | null = null;
  if (bareWasOurs) {
    const barePaths = await detectOpenRestyPaths(executor).catch(() => OPENRESTY_DEFAULT_PATHS);
    if (barePaths.sitesDir !== sitesTarget && (await executor.exists(barePaths.sitesDir))) {
      onLog(log(`Carrying vhosts from ${barePaths.sitesDir}...`));
      beforeCarry = await listDir(executor, sitesTarget);
      await executor
        .exec(`cp -a ${sq(`${barePaths.sitesDir}/.`)} ${sq(`${sitesTarget}/`)} 2>/dev/null || true`)
        .catch(() => {});
    }
  }

  const restoreBare = async () => {
    if (!bareWasOurs) return;
    // Undo the carry BEFORE handing :80 back. This directory is bind-mounted into
    // EVERY edge container on this box, so a conf the carry added and the rollback
    // left behind breaks every future edge start — including the compose stack's
    // own `edge` service, which has nothing to do with this conversion. That is how
    // one failed conversion became "Container … is restarting" on every later
    // `openship up`, with the original cause long out of scroll.
    if (beforeCarry) {
      const now = await listDir(executor, sitesTarget);
      const added = [...now].filter((name) => !beforeCarry!.has(name));
      if (added.length > 0) {
        await executor
          .exec(`rm -f ${added.map((n) => sq(`${sitesTarget}/${n}`)).join(" ")}`)
          .catch(() => {});
        onLog(log(`Removed ${added.length} carried vhost(s) so the next edge start is clean.`, "warn"));
      }
    }
    onLog(log("Restoring the host OpenResty edge...", "warn"));
    await executor.exec("systemctl enable --now openresty 2>/dev/null || true").catch(() => {});
  };

  try {
    // 4. Cut over. Only now does anything stop serving.
    if (bareWasOurs) {
      onLog(log("Stopping the host OpenResty edge..."));
      await executor.exec("systemctl disable --now openresty 2>/dev/null || true").catch(() => {});
      // Not `pkill -f openresty` on a host-networked box: it matches the
      // container's master process too. The unit stop above is the durable one.
      await executor.exec("systemctl reset-failed openresty 2>/dev/null || true").catch(() => {});
    }
    onLog(log("Starting the edge container..."));
    if (!(await startEdgeContainer(executor, container, image, onLog))) {
      throw new Error("the edge container failed to start");
    }

    // 5. Prove it: config valid, then actually answering on :80. A container that
    //    starts and immediately exits passes neither.
    await executor.exec(containerCommand(container, "openresty -t"));
    const listening = await waitForPortListening(executor, 80, {
      timeoutMs: opts.verifyTimeoutMs ?? 30_000,
    });
    if (listening.checked && !listening.listening) {
      throw new Error("the edge container started but nothing is listening on :80");
    }

    const version = await executor
      .exec(containerCommand(container, "openresty -v 2>&1"))
      .catch(() => "");
    onLog(log(`Edge container running${version.trim() ? ` (${version.trim()})` : ""}`));
    return { container, image, converted: bareWasOurs };
  } catch (err) {
    const msg = safeErrorMessage(err);
    onLog(log(`Edge container setup failed: ${msg}`, "error"));
    const logs = await executor
      .exec(`docker logs --tail 40 ${sq(container)} 2>&1 || true`)
      .catch(() => "");
    if (logs.trim()) onLog(log(`Edge container logs:\n${logs}`, "error"));
    await executor.exec(`docker rm -f ${sq(container)} 2>/dev/null || true`).catch(() => {});
    invalidateEdgeContainer(executor);
    await restoreBare();
    // Lead with the CAUSE, not Docker's symptom. A crash-looping edge surfaces as
    // "Container … is restarting, wait until the container is running", which says
    // nothing; nginx's own `[emerg]` line names the actual problem and is the only
    // part of 40 lines of container log anyone needs. The message travels up into
    // the deploy warning, where the container log does not.
    const reason = edgeFailureReason(logs);
    throw new Error(`Edge container setup failed: ${reason ? `${reason} (${msg})` : msg}`);
  }
}
