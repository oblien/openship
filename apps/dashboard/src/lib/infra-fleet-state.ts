import type { ServerContainerGroup } from "@/lib/api/system";
import { applyKey } from "@/lib/infra-apply-status";

/**
 * Fleet state, derived once — what every managed-container surface on the Servers tab
 * renders from: the roll-up counts, the filter segments, and each row's chip.
 *
 * It lives here, as one function, because those three used to derive it separately and
 * could therefore disagree: the card offering "Update all (1)" for a swap already
 * running, next to a row chip still advertising the same update as available.
 *
 * The rule in one line: a component with an apply in flight is counted as in flight
 * and nowhere else — but its SERVER keeps the lane it was in, because a stopped
 * component is still stopped until its restart lands and an update is still due until
 * its swap does.
 */

export type InfraBucket = "attention" | "updates" | "healthy";

/** What one server's managed containers add up to, for chips and filtering. */
export interface InfraServerSummary {
  /** Down components that still exist (a one-click restart), by component. */
  down: ("edge" | "mail")[];
  /** Components running an older image than we pin. */
  updates: number;
  /** Down but gone — the fix is the setup path, so it's not bulk-restartable. */
  missing: ("edge" | "mail")[];
  /** No edge row at all AND projects deployed here → the edge needs installing. */
  edgeAbsent: boolean;
  /** Components mid-apply. Excluded from every other field here. */
  applying: number;
  /** Which lane this server is in. */
  bucket: InfraBucket;
}

export interface InfraCounts {
  /** Servers per lane. */
  attention: number;
  updates: number;
  healthy: number;
  /** Bulk-restartable components (stopped in place, not already being restarted). */
  stopped: number;
  /** Behind components not already being updated — what "Update all (N)" acts on. */
  behind: number;
  /** Components mid-apply, fleet-wide — what the live status renders. */
  applying: number;
}

export interface InfraFleetState {
  summaries: Map<string, InfraServerSummary>;
  counts: InfraCounts;
}

/**
 * @param groups the cached rows, per server
 * @param live   (server, component) keys the progress read says are in flight —
 *               union'd with the rows' own flag, so a run whose cached row was
 *               dropped mid-swap still counts as in flight
 */
export function summarizeInfraFleet(
  groups: ServerContainerGroup[] | null,
  live: ReadonlySet<string> = new Set(),
): InfraFleetState {
  const summaries = new Map<string, InfraServerSummary>();
  for (const g of groups ?? []) {
    const down: ("edge" | "mail")[] = [];
    const missing: ("edge" | "mail")[] = [];
    let updates = 0;
    /** In-flight work, split by the lane it came from. */
    let applyingUpdate = 0;
    let applyingDown = 0;
    for (const r of g.components) {
      const inFlight = r.latestInProgress || live.has(applyKey(g.server.id, r.component));
      if (r.behind) {
        if (inFlight) applyingUpdate++;
        else updates++;
      } else if (r.detail?.down) {
        if (inFlight) applyingDown++;
        else (r.detail.containerMissing ? missing : down).push(r.component);
      }
    }
    const edgeAbsent =
      g.server.projectCount > 0 && !g.components.some((r) => r.component === "edge");
    const bucket: InfraBucket =
      down.length + missing.length > 0 || edgeAbsent || applyingDown > 0
        ? "attention"
        : updates > 0 || applyingUpdate > 0
          ? "updates"
          : "healthy";
    summaries.set(g.server.id, {
      down,
      updates,
      missing,
      edgeAbsent,
      applying: applyingUpdate + applyingDown,
      bucket,
    });
  }

  const counts: InfraCounts = {
    attention: 0,
    updates: 0,
    healthy: 0,
    stopped: 0,
    behind: 0,
    applying: 0,
  };
  for (const s of summaries.values()) {
    if (s.bucket === "attention") counts.attention++;
    else if (s.bucket === "updates") counts.updates++;
    else counts.healthy++;
    counts.stopped += s.down.length;
    counts.behind += s.updates;
    counts.applying += s.applying;
  }
  return { summaries, counts };
}
