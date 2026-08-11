/**
 * Bring a box's already-written vhosts up to the shape THIS build emits.
 *
 * The gap it closes: `registerRoute` is the only thing that writes a vhost, and the only
 * things that call it are a deploy, a domain save, a Retry and cert issuance. So a fix to
 * the generated config — a new realip block, a new location, a changed forwarded header —
 * lands in the code, ships in the release, and then applies to nothing on a box whose
 * projects are simply running. The Cloud-fronted `X-Real-IP` recovery shipped exactly that
 * way: correct generator, upgraded box, unchanged file, every free-domain visitor still
 * logged as Openship Cloud's edge.
 *
 * Converged boxes do no work (each vhost carries the generation it was written by, and a
 * current one is read and skipped), so this is safe to call on the ordinary edge-ensure
 * path rather than behind an operator action.
 *
 * Best-effort like everything else on the routing path: a repair that can't run is a
 * warning, never a failed deploy.
 */

import type { Platform } from "@repo/adapters";
import { safeErrorMessage } from "@repo/core";

type Routing = Platform["routing"];

export interface EdgeVhostRepairResult {
  scanned: number;
  repaired: string[];
  failed: { slug: string; reason: string }[];
}

/**
 * Replay stale vhosts on `routing`'s box.
 *
 * `onLog` is only called when something actually happened — a silent converged box is the
 * normal case and a line per deploy saying "nothing to do" would train operators to skip
 * the one time it says otherwise.
 */
export async function repairEdgeVhosts(
  routing: Routing | null | undefined,
  opts: { onLog?: (message: string, level?: "warn") => void } = {},
): Promise<EdgeVhostRepairResult> {
  const empty: EdgeVhostRepairResult = { scanned: 0, repaired: [], failed: [] };
  // Cloud routes through Oblien's API and desktop has no edge: no generated config on
  // disk means nothing to replay, which is "not applicable", not a failure.
  if (!routing?.reapplyStoredRoutes) return empty;

  let result: EdgeVhostRepairResult;
  try {
    result = await routing.reapplyStoredRoutes();
  } catch (err) {
    const reason = safeErrorMessage(err);
    console.warn(`[edge-vhost-repair] sweep failed (non-fatal): ${reason}`);
    return { ...empty, failed: [{ slug: "*", reason }] };
  }

  if (result.repaired.length > 0) {
    const line =
      `Updated ${result.repaired.length} edge route(s) to this version's config shape: ` +
      `${result.repaired.join(", ")}.`;
    opts.onLog?.(`${line}\n`);
    console.log(`[edge-vhost-repair] ${line}`);
  }
  for (const f of result.failed) {
    const line = `Could not update the edge config for ${f.slug}: ${f.reason}`;
    opts.onLog?.(`${line}\n`, "warn");
    console.warn(`[edge-vhost-repair] ${line}`);
  }
  return result;
}
