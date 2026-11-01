import type { RemoveServerResult, ServerOperations } from "@repo/contracts";

export type ServerDeletionPreview = Awaited<
  ReturnType<ServerOperations["deletionPreview"]>
>["preview"];
export type ServerWorkloadPreview = ServerDeletionPreview["workloads"][number];
export type ServerRemovalResult = RemoveServerResult;
export type ServerRemovalWorkloadResult = RemoveServerResult["workloads"][number];

/**
 * Each workload teardown is its own SSH round-trip, so a fixed client timeout aborts
 * a request the server goes on to finish — leaving the operator staring at a failure
 * over a removal that succeeded. Scale with the count, and only on the destroy path:
 * a record-only removal is DB work and returns immediately.
 */
export function serverRemovalTimeoutMs(opts: {
  destroyOnSource?: boolean;
  workloadCount?: number;
}): number {
  const base = 60_000;
  if (!opts.destroyOnSource) return base;
  const per = 45_000;
  const scaled = base + (opts.workloadCount ?? 0) * per;
  // Ceiling: past this the operator wants a progress view, not a longer spinner.
  return Math.min(scaled, 15 * 60_000);
}

/**
 * Why the "also destroy on the server" option can't be offered, or null.
 *
 * A box that isn't answering can't be asked to stop anything: the teardown would
 * orphan every resource for GC, and GC resolves its transport FROM the server row —
 * which this action is about to delete. So an unreachable server gets the
 * control-plane-only removal, and the reason is shown rather than the checkbox.
 */
export function serverDestroyBlockedReason(
  preview: Pick<ServerDeletionPreview, "reachable"> | null,
): "unreachable" | "unknown" | null {
  if (!preview) return "unknown";
  if (preview.reachable === false) return "unreachable";
  if (preview.reachable === null) return "unknown";
  return null;
}

/** Projects and apps, split for the confirm's two lists. */
export function groupServerWorkloads(workloads: ServerWorkloadPreview[]): {
  projects: ServerWorkloadPreview[];
  apps: ServerWorkloadPreview[];
  /** Listed but NOT removed — the control plane stays whatever the operator picks. */
  staying: ServerWorkloadPreview[];
} {
  const removable = workloads.filter((w) => !w.isControlPlane);
  return {
    projects: removable.filter((w) => !w.isApp),
    apps: removable.filter((w) => w.isApp),
    staying: workloads.filter((w) => w.isControlPlane),
  };
}

export type ServerRemovalSummary =
  | { kind: "removed"; count: number; destroyed: boolean }
  | { kind: "partial"; failed: ServerRemovalWorkloadResult[] };

/**
 * What actually happened, read from the RESPONSE. Never from the flag the client sent:
 * the previous cascade bug was a toast that reported the request instead of the result.
 */
export function serverRemovalSummary(result: ServerRemovalResult): ServerRemovalSummary {
  if (!result.serverRemoved) {
    return {
      kind: "partial",
      failed: result.workloads.filter((w) => !w.ok || (w.orphaned ?? 0) > 0),
    };
  }
  return {
    kind: "removed",
    count: result.removed,
    destroyed: result.destroyOnSource,
  };
}
