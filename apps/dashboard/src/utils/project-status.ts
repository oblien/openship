import type { Dictionary } from "@/i18n";

export type ProjectStatus =
  | "live"
  | "attention"
  | "queued"
  | "building"
  | "deploying"
  | "failed"
  | "cancelled"
  | "deleting"
  | "draft";

export type ProjectStatusSource = {
  activeDeploymentId?: string | null;
  /** Status of the LIVE release (the active deployment's own row). Lets a
   *  caller that can't supply `latestDeploymentId` still tell "the newest deploy
   *  IS the live one" from "there's a newer one that didn't land". */
  activeDeploymentStatus?: string | null;
  latestDeploymentId?: string | null;
  latestDeploymentStatus?: string | null;
  /** True when the live release is a partial-failure deploy still awaiting the
   *  operator's keep/reject decision — surfaced as "Action Required", never
   *  "Live". */
  awaitingDecision?: boolean | null;
  /** True when the live release deployed fine but its free .opsh.io edge route
   *  didn't sync — also surfaced as "Action Required", with a Retry routing
   *  action (distinct from the keep/reject decision above). */
  routingUnsynced?: boolean | null;
  /** True when the LATEST deploy is blocked on a named, clearable cause (status
   *  `action_required` — today a port conflict). Unlike the two flags above this
   *  is not a property of the live release: a blocked deploy never becomes the
   *  active one, so nothing derived from the active deployment can see it, which
   *  is why such a deploy used to vanish from the project entirely. */
  latestDeploymentBlocked?: boolean | null;
  deletedAt?: string | null;
  /** True while an atomic teardown is in flight (the real in-progress flag;
   *  teardown hard-deletes on success, so `deletedAt` is rarely set). */
  deletionInProgress?: boolean | null;
  /** Marks the Openship control-plane self-app. It IS the running host service and
   *  has no deployment behind it, so it must never fall through to "draft". */
  appTemplateId?: string | null;
  isApp?: boolean | null;
  hasServer?: boolean | null;
};

// CSS-only presentation. The human-readable label is resolved from the
// active dictionary via `projectStatusLabel(status, t)` so badges localize.
export const PROJECT_STATUS_META: Record<
  ProjectStatus,
  { badge: string; dot: string }
> = {
  live: {
    badge: "bg-success-bg text-success",
    dot: "bg-success-solid",
  },
  attention: {
    badge: "bg-warning-bg text-warning",
    dot: "bg-warning-solid",
  },
  queued: {
    badge: "bg-info-bg text-info",
    dot: "bg-info-solid",
  },
  building: {
    badge: "bg-info-bg text-info",
    dot: "bg-info-solid",
  },
  deploying: {
    // primary = brand accent, intentionally not a status token.
    badge: "bg-primary/10 text-primary",
    dot: "bg-primary",
  },
  failed: {
    badge: "bg-danger-bg text-danger",
    dot: "bg-danger-solid",
  },
  cancelled: {
    badge: "bg-muted text-muted-foreground",
    dot: "bg-muted-foreground",
  },
  deleting: {
    badge: "bg-danger-bg text-danger",
    dot: "bg-danger-solid animate-pulse",
  },
  draft: {
    badge: "bg-warning-bg text-warning",
    dot: "bg-warning-solid",
  },
};

/** Localized status label for a project/deployment status pill. */
export function projectStatusLabel(status: ProjectStatus, t: Dictionary): string {
  return t.projects.status[status];
}

/**
 * The only latest-deploy statuses that may leave a project looking healthy.
 *
 * An ALLOWLIST, not a denylist: round 1 enumerated the bad statuses and caught
 * the literal "failed" only, so `partial_failure`, `rejected`, `reconciling` —
 * and any status added later — still came back green "Live" over a deploy that
 * never landed. `ready` is a landed deploy; `cancelled` is the operator's own
 * deliberate stop, which needs nothing from them and must not nag forever.
 * Everything else is "the newest deploy did not land".
 */
const SETTLED_HEALTHY_STATUSES = new Set(["ready", "cancelled"]);

/** Why a project reads "attention". Null when it doesn't. */
export type ProjectAttentionReason =
  /** Live release is a partial failure awaiting the operator's keep/reject. */
  | "decision"
  /** Live release's free .opsh.io edge route didn't sync (Retry routing). */
  | "routing"
  /** Newest deploy is blocked on a named, clearable cause (port conflict). */
  | "blocked"
  /** Newest deploy did not land; an older release is still serving. */
  | "newestDeployDidNotLand";

/**
 * Is the newest deploy the one that is actually serving?
 *
 * `latestDeploymentId` is the direct answer, but not every payload carries it
 * (environment summaries send `activeDeploymentStatus` + `latestDeploymentStatus`
 * only), so fall back to comparing the two statuses: a live release whose own
 * status IS the latest status is the latest release.
 */
function latestDeployIsLive(project: ProjectStatusSource): boolean {
  if (!project.activeDeploymentId) return false;
  if (project.latestDeploymentId) return project.activeDeploymentId === project.latestDeploymentId;
  if (project.activeDeploymentStatus && project.latestDeploymentStatus) {
    return project.activeDeploymentStatus === project.latestDeploymentStatus;
  }
  return false;
}

/**
 * Why this project needs the operator, or null. Exported so a card can EXPLAIN
 * the amber pill instead of demanding an action it doesn't name — see
 * `projectStatusHint`.
 */
export function getProjectAttentionReason(
  project: ProjectStatusSource,
): ProjectAttentionReason | null {
  if (project.appTemplateId === "openship") return null;
  if (project.deletedAt || project.deletionInProgress) return null;
  if (project.awaitingDecision) return "decision";
  if (project.routingUnsynced) return "routing";
  if (project.latestDeploymentBlocked) return "blocked";

  const latest = project.latestDeploymentStatus;
  if (!latest || SETTLED_HEALTHY_STATUSES.has(latest)) return null;
  if (["queued", "building", "deploying"].includes(latest)) return null;
  if (latest === "action_required") return "blocked";
  // A latest deploy that didn't land, while something older still serves.
  if (project.activeDeploymentId && !latestDeployIsLive(project)) {
    return "newestDeployDidNotLand";
  }
  return null;
}

export function getProjectStatus(project: ProjectStatusSource): ProjectStatus {
  if (project.deletedAt || project.deletionInProgress) {
    return "deleting";
  }

  // The Openship control-plane self-app IS the running host process; it has no
  // deployment record, so it must never render as "draft" with a "Deploy now"
  // CTA. If you can see the dashboard, it's live.
  if (project.appTemplateId === "openship") {
    return "live";
  }

  switch (project.latestDeploymentStatus) {
    case "queued":
      return "queued";
    case "building":
      return "building";
    case "deploying":
      return "deploying";
    default:
      break;
  }

  // Needs the operator: a partial-failure deploy awaiting keep/reject, one whose
  // free-domain edge route didn't sync, or a newer deploy blocked on a named
  // cause. All flag "Action Required" — never the green "Live".
  //
  // Deliberately BEFORE the `activeDeploymentId → live` check below: a project
  // whose last release is serving fine but whose newest deploy is blocked is not
  // simply "Live", or the blocker would be invisible on every card and sidebar.
  if (project.awaitingDecision || project.routingUnsynced || project.latestDeploymentBlocked) {
    return "attention";
  }

  // A LATEST deploy that didn't land cleanly must never render the green "Live".
  // Sits BEFORE the `activeDeploymentId → live` check below, which used to
  // short-circuit every failure arm at the bottom entirely.
  //
  // Allowlist, not denylist (SETTLED_HEALTHY_STATUSES): checking for the literal
  // "failed" left `partial_failure`, `rejected` and `reconciling` reading green.
  //
  // Which honest signal depends on whether anything is actually serving. A
  // non-landing deploy doesn't advance the project's live pointer, so a live
  // pointer that ISN'T this deploy is an older, healthy release: the site is up
  // but the newest deploy didn't land → "attention". The one exception is a
  // partial failure the operator already KEPT: that release IS the live one and
  // its decision is made (`awaitingDecision` above is what flags an open one).
  const latest = project.latestDeploymentStatus;
  if (latest && !SETTLED_HEALTHY_STATUSES.has(latest)) {
    if (latestDeployIsLive(project)) {
      // The non-ready latest IS the serving release. `failed` still can't be
      // "live" — nothing that failed is serving — but a kept partial is.
      return latest === "failed" ? "failed" : "live";
    }
    if (project.activeDeploymentId) return "attention";
    return latest === "failed" ? "failed" : "attention";
  }

  if (project.activeDeploymentId) {
    return "live";
  }

  switch (project.latestDeploymentStatus) {
    case "cancelled":
      return "cancelled";
    default:
      return "draft";
  }
}

/**
 * One localized line explaining an amber "Action Required" pill — the pill's
 * `title`. Some attention states have no clearable pending-action (a project
 * rolled back to an older release after a failed deploy sits at
 * active=d1/latest=d2:failed indefinitely), so without this the UI demands an
 * action it never names. Composed from existing copy: state, then the move.
 */
export function projectStatusHint(project: ProjectStatusSource, t: Dictionary): string | null {
  const p = t.projects;
  switch (getProjectAttentionReason(project)) {
    case "decision":
      return `${p.redeploy.actionRequiredTitle} — ${p.redeploy.reviewDeployment}`;
    case "routing":
      return `${p.routingRetry.title} — ${p.routingRetry.retry}`;
    case "blocked":
      return `${p.draft.headingFailed} — ${p.redeploy.reviewDeployment}`;
    case "newestDeployDidNotLand":
      return `${p.draft.headingFailed} — ${p.redeploy.redeployLatest}`;
    default:
      return null;
  }
}

/**
 * The hostname a project card / sidebar is allowed to print.
 *
 * ONLY a persisted route. This used to fall back to `<slug>.<baseDomain>`, which
 * meant every project with no route at all advertised a free subdomain that had
 * never been created: the Apps list read "convex.opsh.io" while that project's
 * own Domains page correctly read "No domain". A route exists because a human
 * chose it and it was persisted — never because a card could compose one.
 */
export function projectDisplayDomain(project: { primaryDomain?: string | null }): string | null {
  return project.primaryDomain?.trim() || null;
}
