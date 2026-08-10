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
  EDGE_CHALLENGE_HOST_DIR,
  OPENRESTY_DEFAULT_PATHS,
} from "../../infra/openresty-lua";
import { sq } from "../local-shell";
import {
  containerImageRef,
  dockerAvailable,
  fromSourceImageMissingMessage,
  imageExistsLocally,
  managedImagesAreFromSource,
  swapManagedImage,
} from "../managed-image";
import { containerCommand, edgeContainerExecutor } from "../edge-container-executor";
import { waitForPortListening } from "../port-listen";
import {
  EDGE_CONTAINER_NAME,
  edgeCrashReason,
  edgeFailureReason,
  edgeIsBroken,
  sanitizeEdgeVhosts,
  invalidateEdgeContainer,
  resolveOurEdgeContainer,
} from "./detect";
import { completeEdgeTakeover, rollbackEdgeTakeover } from "./takeover-journal";
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

/**
 * Options a caller may pass through to the underlying NginxProvider. `executor`,
 * `paths` and `pinPaths` are decided HERE and are deliberately not overridable —
 * they're the whole point of these two builders.
 */
export type EdgeProviderOptions = Omit<
  NginxProviderOptions,
  "executor" | "paths" | "pinPaths" | "containerEdge" | "challengeDir"
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
    // Challenge tokens go to the HOST side of the ACME mount, for the same reason
    // vhosts do. This is the ONE mount whose two sides differ
    // (/var/lib/openship/edge/acme → /var/www/acme), so the write path and the
    // vhost's `root` are genuinely different strings — `root` stays the container
    // path. Overridden here and nowhere else, next to the `paths` override it
    // mirrors, so the two cannot drift.
    challengeDir: EDGE_CHALLENGE_HOST_DIR,
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
 * The edge's "start this image AND prove it's actually serving" callback — the unit
 * `swapManagedImage` drives. It is the SAME verdict the create path uses: an image swap that leaves a
 * crash-looping container behind must read as a failed swap, not a successful one —
 * `waitForPortListening` alone said "listening" whenever ANY proxy held :80,
 * including the one we were replacing.
 */
function makeEdgeStart(
  executor: CommandExecutor,
  container: string,
  opts: ContainerEdgeOptions,
): (image: string) => Promise<boolean> {
  const { onLog } = opts;
  return async (image: string) => {
    if (!(await startEdgeContainer(executor, container, image, onLog))) return false;
    const verdict = await verifyEdgeServing(executor, container, {
      timeoutMs: opts.verifyTimeoutMs ?? 30_000,
    });
    if (!verdict.serving && verdict.reason) onLog(log(`Edge ${image}: ${verdict.reason}`, "warn"));
    return verdict.serving;
  };
}

/** Verdict of {@link verifyEdgeServing}. `reason` is set iff `serving` is false. */
export interface EdgeServingVerdict {
  serving: boolean;
  reason?: string;
}

/**
 * Is this edge container ACTUALLY SERVING? The one definition, used by every path
 * in this module that needs to answer that.
 *
 * It exists because "the container is running" is not the same claim, and docker
 * makes them look identical: a container crash-looping on
 * `bind() … (98: Address already in use)` reports `.State.Running == true`, appears
 * in plain `docker ps`, and therefore satisfies `resolveOurEdgeContainer`. Every
 * caller that keyed on that answered yes about a box serving nothing — which is how
 * "Fix edge" logged `edge installed successfully`, returned a green banner, and left
 * the "Edge down" issue on screen forever.
 *
 * Three checks, cheapest first, each answering something the others can't:
 *   1. `.State.Status` — the only signal that distinguishes crash-looping from up.
 *   2. `openresty -t` (opt-in) — a config the edge would refuse to reload later.
 *   3. a listener on :80 — the end-to-end fact; everything else is a proxy for it.
 *
 * `timeoutMs: 0` makes it a single-shot probe for the idempotent read path (this
 * runs per deploy); the create/convert path passes a real timeout because a fresh
 * container binds a beat after `docker run` returns.
 */
export async function verifyEdgeServing(
  executor: CommandExecutor,
  container: string,
  opts: { timeoutMs?: number; configTest?: boolean } = {},
): Promise<EdgeServingVerdict> {
  if (await edgeIsBroken(executor, container)) {
    const reason = await edgeCrashReason(executor, container);
    return { serving: false, reason: reason ?? "the edge container is not running" };
  }

  if (opts.configTest) {
    try {
      await executor.exec(containerCommand(container, "openresty -t 2>&1"));
    } catch (err) {
      const out = safeErrorMessage(err);
      return { serving: false, reason: edgeFailureReason(out) ?? out };
    }
  }

  const listening = await waitForPortListening(executor, 80, { timeoutMs: opts.timeoutMs ?? 0 });
  if (listening.checked && !listening.listening) {
    // Prefer the container's own `[emerg]`: "nothing is listening" is the symptom,
    // `bind() … Address already in use` is the thing the operator can act on.
    const reason = await edgeCrashReason(executor, container);
    return {
      serving: false,
      reason: reason ?? "the edge container is up but nothing is listening on :80",
    };
  }

  return { serving: true };
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
    // "Ours" is not "working". `resolveOurEdgeContainer` is a RUNNING-only probe and
    // docker calls a crash-looping container running, so this branch used to return
    // success for a box whose edge had never once bound :80 — the caller logged
    // "edge installed successfully" while the "Edge down" issue stayed on screen,
    // and no amount of pressing Fix could change that. Verified before we return.
    const verdict = await verifyEdgeServing(executor, existing);
    if (!verdict.serving) {
      onLog(log(`The edge container exists but isn't serving: ${verdict.reason}`, "warn"));
      onLog(log("Recreating it...", "warn"));
      // Fall through to the full create path. That path runs the consent gate, which
      // is what actually resolves the usual cause of a crash loop — another proxy
      // holding :80 — and `startEdgeContainer` `docker rm -f`s the flapper on the way
      // in. Returning success here (as this branch used to) is what made the crash
      // loop permanent: the one code path that could have fixed it was skipped
      // because the flapper counted as "already installed".
    } else {
      // Already ours and serving. The only thing left to reconcile is the IMAGE: the
      // edge's Lua and nginx.conf are baked in, so an edge left on an old tag keeps
      // serving rules a newer API assumes it rewrote. Upgrading the API upgrades the
      // edge. Staleness is a plain tag-compare: the dev tag is content-derived
      // (`…-dev.<hash>`), so a source edit moves it exactly like a prod version bump —
      // no image-ID probe needed. `swapManagedImage` pulls only if the target tag
      // isn't already on the box (deliver placed the dev image there first).
      const current = await containerImageRef(executor, existing);
      // A null ref (the image reads back empty in a TOCTOU) is left alone, not judged
      // stale — recreating a serving container onto the same image buys nothing.
      const stale = current != null && current !== image;
      if (stale) {
        const start = makeEdgeStart(executor, existing, opts);
        const swap = await swapManagedImage(executor, {
          kind: "edge",
          from: current ?? image,
          to: image,
          label: "edge",
          onLog,
          start,
        });
        return {
          container: existing,
          image,
          converted: false,
          updated: swap.swapped,
          edgeDown: swap.down,
        };
      }
      return { container: existing, image, converted: false };
    }
  }

  if (!(await dockerAvailable(executor))) {
    throw new Error(
      "Docker isn't available on this server, and the edge now runs as a container. " +
        "Install the Docker component first, then set up the edge.",
    );
  }

  // 1. Pull, and make the host state dirs, BEFORE anything stops serving. A
  //    registry failure has to land here: past the consent gate the old proxy is
  //    already down, so "the box is unchanged and still serving" would be a lie and
  //    a failed pull would leave a live box with no proxy at all.
  //
  //    Skipped when the image is already on the box: in dev the control plane built
  //    the `…-dev.<hash>` image from our source and shipped it here (see
  //    deliverManagedImage), so the unpublished tag is present and a pull would 404.
  //    In prod the tag is absent → this pulls `:APP_VERSION` from the registry.
  if (!(await imageExistsLocally(executor, image))) {
    if (managedImagesAreFromSource("edge")) {
      // The image is an unpublished from-source (dev) tag that the control plane was
      // meant to build and ship here (deliverManagedImage). It isn't on the box, so
      // that build/ship didn't run or didn't finish — a pull can only 404. Fail with
      // the real cause instead of "check the server's network access to the registry".
      throw new Error(fromSourceImageMissingMessage("edge", image));
    }
    onLog(log(`Pulling edge image ${image}...`));
    const pull = await executor.streamExec(`docker pull ${sq(image)}`, onLog as (l: LogEntry) => void);
    if (pull.code !== 0) {
      throw new Error(
        `Could not pull the edge image ${image} — the box is unchanged and still serving. ` +
          "Check the server's network access to the registry, then retry.",
      );
    }
  }
  for (const mount of EDGE_CONTAINER_MOUNTS) {
    await executor.exec(`mkdir -p ${sq(mount.host)}`).catch(() => {});
  }

  // 2. Whatever holds 80/443 → the ONE consent/takeover gate, which prompts, imports
  //    the occupant's sites, journals how to restore it, stops it, and waits for the
  //    sockets to be RELEASED before returning.
  //
  //    A DEPRECATED BARE-HOST OpenResty goes through here too, as an ordinary foreign
  //    proxy — same prompt, same site import, same journaled stop as a distro nginx or
  //    a Caddy (`canImportProxy("openresty")` is true and `scanOpenshipEdge` reads both
  //    bare layouts). There is no second "decommission the legacy edge" path, because
  //    a second path is how the first one got skipped: detect used to call a host
  //    OpenResty "ours", so this gate returned clean, the host proxy kept :80, and the
  //    edge container crash-looped forever while every surface reported it installed.
  const clear = await ensureEdgeClear(executor, opts.config, onLog);

  try {
    // 3. Start. The ports are PROVABLY free by now, so failing to bind here is a real
    //    failure and not a race we should have waited out.
    onLog(log("Starting the edge container..."));
    if (!(await startEdgeContainer(executor, container, image, onLog))) {
      throw new Error("the edge container failed to start");
    }

    // 4. Prove it — the shared verdict, so this path and the idempotent read path
    //    cannot disagree about what "serving" means. `configTest` because a takeover
    //    may just have imported foreign vhosts, and that is where a bad one shows up.
    const verdict = await verifyEdgeServing(executor, container, {
      configTest: true,
      timeoutMs: opts.verifyTimeoutMs ?? 30_000,
    });
    if (!verdict.serving) {
      throw new Error(verdict.reason ?? "the edge container started but isn't serving");
    }

    // The takeover is only settled once our edge is proven serving — until this line
    // the journal stays unfinished on purpose, so a crash between the stop and here is
    // repaired at next boot by `recoverInterruptedTakeover`.
    if (clear.tookOver) await completeEdgeTakeover(executor);

    const version = await executor
      .exec(containerCommand(container, "openresty -v 2>&1"))
      .catch(() => "");
    onLog(log(`Edge container running${version.trim() ? ` (${version.trim()})` : ""}`));
    return { container, image, converted: clear.tookOver };
  } catch (err) {
    const msg = safeErrorMessage(err);
    onLog(log(`Edge container setup failed: ${msg}`, "error"));
    const logs = await executor
      .exec(`docker logs --tail 40 ${sq(container)} 2>&1 || true`)
      .catch(() => "");
    if (logs.trim()) onLog(log(`Edge container logs:\n${logs}`, "error"));
    await executor.exec(`docker rm -f ${sq(container)} 2>/dev/null || true`).catch(() => {});
    invalidateEdgeContainer(executor);
    // Put back exactly what the consent gate stopped, from its journal — the one
    // rollback implementation, shared with the CLI's two-process takeover and with
    // boot recovery. Gated on `tookOver` so a plain failed install on a box that was
    // already free doesn't replay someone else's stale journal.
    if (clear.tookOver) await rollbackEdgeTakeover(executor, onLog);
    // Lead with the CAUSE, not Docker's symptom. A crash-looping edge surfaces as
    // "Container … is restarting, wait until the container is running", which says
    // nothing; nginx's own `[emerg]` line names the actual problem and is the only
    // part of 40 lines of container log anyone needs. The message travels up into
    // the deploy warning, where the container log does not.
    const reason = edgeFailureReason(logs);
    throw new Error(`Edge container setup failed: ${reason ? `${reason} (${msg})` : msg}`);
  }
}
