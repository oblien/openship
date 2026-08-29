/**
 * The decisions "Remove server" makes, extracted from the modal for the same reason
 * `signup-next.ts` and `environment-next.ts` were: they are the parts that were wrong
 * before, and none of them is reachable from a React test.
 *
 * The removal is not a single destructive act — it resolves the fate of every workload
 * bound to the box. Getting the *report* of that wrong is how the last delete-cascade
 * bug shipped: a checkbox promised a cascade the server never performed, and the toast
 * repeated the promise because it was built from the flag the client had SENT rather
 * than from what came back. So `serverRemovalSummary` reads the response, and nothing
 * else.
 */

/** One project/app currently running on the server, as the preview reports it. */
export interface ServerWorkloadPreview {
  id: string;
  name: string;
  slug: string;
  environmentName: string;
  environmentSlug: string;
  groupName: string | null;
  isApp: boolean;
  /** The control plane itself — it cannot be torn down, so it is listed as staying. */
  isControlPlane: boolean;
  /** Carried raw: `getProjectStatus` derives live-vs-draft from it, so the modal
   *  needs no second definition of "live". */
  activeDeploymentId: string | null;
}

export interface ServerDeletionPreview {
  serverId: string;
  serverName: string;
  sshHost: string;
  isLocal: boolean;
  workloads: ServerWorkloadPreview[];
  projectCount: number;
  appCount: number;
  alsoRemoved: {
    mailConfigured: boolean;
    tunnels: number;
    githubRegistration: boolean;
  };
  alsoUnbound: {
    backupDestinations: number;
  };
  /** null = could not be determined (the probe itself failed), not "unreachable". */
  reachable: boolean | null;
}

/** Per-workload outcome from the DELETE — the same shape on success and on 409. */
export interface ServerRemovalWorkloadResult {
  id: string;
  name: string;
  ok: boolean;
  orphaned?: number;
  error?: string;
}

export interface ServerRemovalResult {
  ok: boolean;
  code?: string;
  error?: string;
  serverRemoved: boolean;
  destroyOnSource: boolean;
  workloads: ServerRemovalWorkloadResult[];
  removed?: number;
}

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
    count: result.removed ?? result.workloads.length,
    destroyed: result.destroyOnSource,
  };
}
