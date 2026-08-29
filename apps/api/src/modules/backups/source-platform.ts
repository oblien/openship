/**
 * @module source-platform
 *
 * The runtime a backup or a restore drives for one project service — resolved
 * ONCE, for both directions.
 *
 * ## Why this isn't just `resolveDeploymentPlatform`
 *
 * Both orchestrators used to read the runtime straight off the active deployment's
 * snapshot: `runtimeMode: "docker"` → the Docker executor, anything else → the bare
 * one. That is right for a deployment Openship performed, because the snapshot
 * records how it performed it. It is wrong for a service Openship ADOPTED, where
 * the snapshot describes the adoption rather than the workload.
 *
 * The reported case is the control plane's own project ([#611](https://github.com/oblien/openship/issues/611)).
 * `openship up` runs Openship as a Docker compose stack, and the self-app's adopt
 * deployment is stamped `runtimeMode: "bare"` — accurately, for what that adopt
 * did: it health-probed a port with `BareRuntime` and never started a container.
 * Its five service rows, though, are created from the running compose containers
 * and are Docker through and through. So a backup policy on its `postgres` service
 * resolved the BARE executor, whose `listSources()` can only read the service
 * row's `volumes` column — empty for rows built from containers — and whose
 * `execStream` runs on the HOST, where there is no `pg_dump`. Zero sources, zero
 * artifacts, and (before the orchestrator learned to fail on that) a green run.
 *
 * ## The rule
 *
 * A service with a live container is backed up through the container, whatever the
 * snapshot says. "Bare, but there is a container" is a contradiction, and the
 * container is the half that's observable.
 *
 * Two guards keep that from over-reaching:
 *
 *  - **Only `bare` is ever overridden.** `cloud` has its own executor and its own
 *    container semantics; nothing here should second-guess it.
 *  - **The container is VERIFIED on the daemon first.** A genuinely bare deployment
 *    can carry a `containerId` that is not a container at all — `BareRuntime`'s
 *    adopt returns a pid, and `ensureAdoptDeployment` falls back to the deployment
 *    id — so "it has a container id" is not evidence. Asking the daemon whether the
 *    id exists is, and it costs one list call on a path that is about to stream
 *    gigabytes.
 *
 * When the probe says no, the bare runtime is kept and the run proceeds exactly as
 * before. This can only ever upgrade a source that really is containerized.
 */

import {
  disposeRuntime,
  resolveDeploymentPlatform,
  type DeploymentMeta,
} from "../../lib/deployment-runtime";
import { resolveExecutor, type BackupExecutor, type RuntimeAdapter } from "@repo/adapters";
import { safeErrorMessage, withTimeout } from "@repo/core";

/**
 * Ceiling on the "is this really a container?" probe.
 *
 * The probe is an optimisation on a path that is about to stream gigabytes, so it must
 * never become the reason a backup does not start. `listAllContainers()` over a
 * Docker-over-SSH bridge has no request timeout of its own, so an unreachable-but-not-
 * refusing daemon would hang here forever — before the run has produced a byte, and
 * with nothing in the run row to explain why. Short, because a daemon that cannot list
 * containers in this long is not one we want to stream a dump through either.
 */
const CONTAINER_PROBE_TIMEOUT_MS = 15_000;

export interface ResolvedSourceExecutor {
  /** Caller owns this: hand it to `disposeRuntime` when the run is done. A remote
   *  server's Docker-over-SSH bridge is only closed by `dispose()`. */
  runtime: RuntimeAdapter;
  executor: BackupExecutor;
}

/** Does `containerId` name a container this runtime can actually see? */
async function containerExists(
  runtime: RuntimeAdapter,
  containerId: string,
): Promise<boolean> {
  if (!runtime.supports("hostContainerQuery") || !runtime.listAllContainers) return false;
  const containers = await withTimeout(
    runtime.listAllContainers(),
    CONTAINER_PROBE_TIMEOUT_MS,
    `container probe did not answer in ${CONTAINER_PROBE_TIMEOUT_MS / 1000}s`,
  ).catch(() => null);
  if (!containers) return false;
  // Recorded ids are full 64-char ids, but compare both ways: a short id from an
  // older row must still match, and a full id must match the summary's full id.
  return containers.some(
    (c) => c.id === containerId || c.id.startsWith(containerId) || containerId.startsWith(c.id),
  );
}

/**
 * Resolve the runtime + backup executor for a project service.
 *
 * `containerId` is the LIVE id the caller already resolved (verified against the
 * host by `liveContainerIdForService`), or null when the service has none.
 */
export async function resolveSourceExecutor(args: {
  meta: unknown;
  organizationId: string;
  containerId: string | null;
  /** Only for the log line when the override fires. */
  serviceName: string;
}): Promise<ResolvedSourceExecutor> {
  const snapshotMeta = args.meta as DeploymentMeta;
  const snapshot = await resolveDeploymentPlatform(snapshotMeta, {
    organizationId: args.organizationId,
  });
  const snapshotRuntime = snapshot.platform.runtime;

  const worthProbing = snapshotRuntime.name === "bare" && !!args.containerId;
  if (!worthProbing) {
    return {
      runtime: snapshotRuntime,
      executor: resolveExecutor(snapshotRuntime.name, snapshotRuntime),
    };
  }

  let dockerRuntime: RuntimeAdapter | null = null;
  try {
    const asDocker = await resolveDeploymentPlatform(
      { ...snapshotMeta, runtimeMode: "docker" },
      { organizationId: args.organizationId },
    );
    dockerRuntime = asDocker.platform.runtime;
    if (
      dockerRuntime.name === "docker" &&
      (await containerExists(dockerRuntime, args.containerId!))
    ) {
      console.log(
        `[backup] service "${args.serviceName}" is a container (${args.containerId!.slice(0, 12)}) ` +
          `but its deployment snapshot says runtimeMode=bare — backing it up through Docker.`,
      );
      disposeRuntime(snapshotRuntime);
      return {
        runtime: dockerRuntime,
        executor: resolveExecutor(dockerRuntime.name, dockerRuntime),
      };
    }
  } catch (err) {
    // No reachable daemon, no permission, a target that can't produce one — all of
    // them mean "not containerized as far as we can tell", which is the snapshot's
    // answer anyway. Never fail a run over a probe.
    console.warn(
      `[backup] docker probe for service "${args.serviceName}" failed, using the ` +
        `deployment's own runtime: ${safeErrorMessage(err)}`,
    );
  }

  disposeRuntime(dockerRuntime);
  return {
    runtime: snapshotRuntime,
    executor: resolveExecutor(snapshotRuntime.name, snapshotRuntime),
  };
}
