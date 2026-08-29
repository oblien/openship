import type {
  ContainerApplyActive,
  ContainerApplySettled,
  ContainerApplyStep,
} from "@/lib/api/system";

/**
 * Fleet apply progress, as arithmetic — the pure half of the managed-container
 * status the Servers-tab roll-up renders while edge/mail swaps are running.
 *
 * Kept out of the hook and the card so the two things that are easy to get wrong
 * are testable on their own: which phase word a target is in (a RESTART has no
 * image to pull, so the swap step model doesn't describe it), and a percentage
 * that never claims 100 while work is still in flight.
 */

/** Stable identity for one (server, component) apply across polls. */
export function applyKey(serverId: string, component: "edge" | "mail"): string {
  return `${serverId}:${component}`;
}

/** The phase a target is in, as a copy key rather than a server-sent English label. */
export type ApplyPhase = "queued" | "starting" | "pull" | "recreate" | "verify";

const SETTLED: ReadonlySet<ContainerApplyStep["status"]> = new Set(["done", "error"]);

/**
 * What this target is doing right now.
 *
 * A queued target has no session at all. A REPAIR reuses the swap's three-step
 * model but performs none of it (nothing is pulled to start a stopped container),
 * so it reports the neutral "starting" phase instead of narrating a pull that
 * isn't happening. Everything else reads the step model: the running step, else
 * the first unfinished one, else the last (all done — the row is about to settle).
 */
export function applyPhase(target: ContainerApplyActive): ApplyPhase {
  if (target.state === "queued") return "queued";
  if (target.intent === "repair") return "starting";
  const steps = target.steps ?? [];
  if (steps.length === 0) return "pull";
  return (steps.find((s) => s.status === "running") ?? steps.find((s) => !SETTLED.has(s.status)) ?? steps[steps.length - 1]!).id;
}

/**
 * One percentage for the whole in-flight set: every target weighs the same, and a
 * running step counts as half its own weight so a long pull still moves the bar.
 *
 * Clamped to 4..99 while anything is in flight — the same rule the install
 * progress panel uses. Never 100: 100 means finished, and finished is when the
 * target leaves this set.
 */
export function applyPercent(active: ContainerApplyActive[]): number {
  if (active.length === 0) return 0;
  let sum = 0;
  for (const target of active) {
    const steps = target.steps ?? [];
    if (target.state === "queued" || steps.length === 0) continue;
    const done = steps.filter((s) => SETTLED.has(s.status)).length;
    const running = steps.filter((s) => s.status === "running").length;
    sum += (done + running * 0.5) / steps.length;
  }
  return Math.min(99, Math.max(4, Math.round((sum / active.length) * 100)));
}

/** Which intent the in-flight set is mostly about — picks the headline wording. */
export function applyIntentOf(active: ContainerApplyActive[]): "update" | "repair" {
  return active.some((t) => t.intent !== "repair") ? "update" : "repair";
}

export interface ApplyOutcome {
  done: number;
  failed: number;
  /** First failure reason, for the line under the count. */
  error?: string;
}

/**
 * Roll settled applies up into the "done" beat, restricted to the runs this client
 * actually watched.
 *
 * The restriction is the point: the endpoint reports everything that finished in
 * its window, so without it a surface mounted after the fact would announce work
 * the operator never started here.
 *
 * One result per (server, component), and the LAST one wins: a component applied
 * twice inside the reporting window appears twice, and the older attempt must not
 * be the one that gets announced.
 */
export function summarizeSettled(
  recent: ContainerApplySettled[],
  watched: ReadonlySet<string>,
): ApplyOutcome | null {
  const latest = new Map<string, ContainerApplySettled>();
  for (const entry of recent) {
    const key = applyKey(entry.serverId, entry.component);
    if (!watched.has(key)) continue;
    const held = latest.get(key);
    if (!held || held.finishedAt <= entry.finishedAt) latest.set(key, entry);
  }
  let done = 0;
  let failed = 0;
  let error: string | undefined;
  for (const entry of latest.values()) {
    if (entry.ok) done++;
    else {
      failed++;
      error ??= entry.error;
    }
  }
  if (done === 0 && failed === 0) return null;
  return { done, failed, ...(error ? { error } : {}) };
}
