/**
 * "Does this volume already exist on the TARGET, holding someone else's data?" — the one
 * answer, for every path that asks.
 *
 * It existed three times. The relay path used the adapter's `probeVolume`, which mounts the
 * volume into a helper container and reports `empty: false` when the result is unreadable
 * or ambiguous — explicitly "so we err on the side of NOT clobbering". The migration
 * preview and the DEFAULT direct path each had a byte-identical shell copy instead:
 *
 *     docker volume inspect <v> -f '{{.Mountpoint}}' ; [ -n "$(ls -A "$mp")" ] && echo CONFLICT
 *     …  .catch(() => "")
 *
 * which inverts the fail-safe. `/var/lib/docker/volumes` is root-only `0700`, and
 * direct-transfer already recognises "the SSH user cannot read/write the Docker volume
 * path" as a normal condition — so on a target reached through a NON-ROOT ssh account both
 * copies saw every target volume as empty and the migration overwrote an unrelated stack's
 * populated volume. The same run with `transferMode: "stream"` refused it. That is the
 * precise data loss the guard exists to prevent, decided by which transfer mode you picked.
 *
 * This resolves through the adapter for everyone, and treats "could not tell" as a
 * conflict. A false conflict costs the operator one explicit choice in the wizard; a false
 * clear costs them their data.
 */

import { resolveExecutor, type ServiceHandle } from "@repo/adapters";
import { safeErrorMessage } from "@repo/core";
import { createServerDockerRuntime } from "../../lib/deployment-runtime";

/**
 * The ONE per-volume verdict: may this target volume be written over?
 *
 * `null` = yes (it does not exist, or exists and is empty). Otherwise it BLOCKS, and says
 * why. Shared by the name-keyed helper below and the relay path, which holds task handles
 * rather than names — both needed the same fail-safe and only one had it: an executor with
 * NO `probeVolume` made the relay's `!probe?.exists` read as "no conflict", the same
 * fail-OPEN the shell copies had.
 */
export async function probeOneVolume(
  exec: { probeVolume?: (h: ServiceHandle, id: string) => Promise<{ exists: boolean; empty: boolean }> },
  handle: ServiceHandle,
  sourceId: string,
  onLog?: (message: string) => void,
): Promise<VolumeConflictReason | null> {
  // No probe at all is not evidence of emptiness.
  if (!exec.probeVolume) return "unknown";
  try {
    const probe = await exec.probeVolume(handle, sourceId);
    if (!probe.exists || probe.empty) return null;
    return "occupied";
  } catch (err) {
    onLog?.(
      `could not inspect target volume ${sourceId} (${safeErrorMessage(err)}) — ` +
        `treating it as unverified rather than overwriting it`,
    );
    return "unknown";
  }
}

/** A volume to check on the target daemon. */
export interface VolumeConflictQuery {
  /** Owning service, for the operator-facing message. */
  serviceName: string;
  /** Bare volume name as it will exist on the TARGET daemon. */
  volume: string;
}

/** Why a volume is being reported. `occupied` = we LOOKED and it holds data.
 *  `unknown` = we could not tell, which is treated as blocking but is a different thing to
 *  say to an operator — "holds data" is a lie when the daemon never answered. */
export type VolumeConflictReason = "occupied" | "unknown";

/**
 * Volumes that must not be written over: those that exist and hold data, plus those we
 * could not check.
 *
 * Fail-safe by construction — a runtime that cannot be reached, an executor with no
 * `probeVolume`, or a probe that throws all BLOCK, because none of them is evidence that
 * the volume is empty. But they are reported as `unknown`, not `occupied`: an unreachable
 * daemon that renders as "every volume already holds data" sends the operator hunting for
 * data that isn't there, and hides the real fault (the target is unreachable).
 */
export async function probeTargetVolumeConflicts(opts: {
  targetServerId: string;
  organizationId: string;
  projectId: string;
  projectSlug: string;
  queries: VolumeConflictQuery[];
  onLog?: (message: string) => void;
}): Promise<Map<string, VolumeConflictReason>> {
  const conflicts = new Map<string, VolumeConflictReason>();
  if (opts.queries.length === 0) return conflicts;

  let rt: Awaited<ReturnType<typeof createServerDockerRuntime>> | null = null;
  try {
    rt = await createServerDockerRuntime(opts.targetServerId, opts.organizationId);
  } catch (err) {
    // Could not ask at all → every candidate is a conflict. The alternative is
    // overwriting on the strength of a failed connection.
    opts.onLog?.(
      `could not reach the target's docker API (${safeErrorMessage(err)}) — treating all ` +
        `${opts.queries.length} target volume(s) as unverified rather than overwriting them`,
    );
    for (const q of opts.queries) conflicts.set(q.volume, "unknown");
    return conflicts;
  }

  try {
    const exec = resolveExecutor("docker", rt);
    for (const q of opts.queries) {
      // A handle that enumerates exactly this one BARE volume: `containerId: null` takes
      // the adapter's DB-fallback branch (right here — on the target this project has no
      // container yet) and `namespaceVolumes: false` keeps the raw name, which is what a
      // cross-server move writes to. The mount point is arbitrary; only the name matters.
      const handle: ServiceHandle = {
        id: `${opts.projectId}:${q.serviceName}`,
        projectId: opts.projectId,
        name: q.serviceName,
        image: null,
        env: {},
        volumes: [`${q.volume}:/probe`],
        containerId: null,
        projectSlug: opts.projectSlug,
        namespaceVolumes: false,
      };
      try {
        const sources = await exec.listSources(handle);
        const source = sources.find((s) => s.type === "volume" && s.source === q.volume);
        // Should not happen for a bare name, but a source we cannot even enumerate is a
        // thing we cannot claim is empty.
        if (!source) {
          conflicts.set(q.volume, "unknown");
          continue;
        }
        const verdict = await probeOneVolume(exec, handle, source.id, opts.onLog);
        if (verdict) conflicts.set(q.volume, verdict);
      } catch (err) {
        opts.onLog?.(
          `could not enumerate target volume ${q.volume} (${safeErrorMessage(err)}) — ` +
            `treating it as unverified rather than overwriting it`,
        );
        conflicts.set(q.volume, "unknown");
      }
    }
  } finally {
    await rt.dispose().catch(() => {});
  }
  return conflicts;
}
