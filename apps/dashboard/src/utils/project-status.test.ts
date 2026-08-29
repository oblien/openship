import { describe, expect, it } from "vitest";

import {
  PROJECT_STATUS_META,
  getProjectAttentionReason,
  getProjectStatus,
  migrationNeedsOperator,
  projectDisplayDomain,
  projectStatusHint,
  projectStatusLabel,
} from "./project-status";
import { baseDictionary as en } from "@/i18n";
import {
  calculateDeploymentStats,
  filterDeployments,
  getStatusConfig,
} from "@/app/(dashboard)/deployments/utils";
import type { Deployment } from "@/app/(dashboard)/deployments/types";

/**
 * `action_required` is a deploy that failed on a cause we can NAME and the
 * operator can clear (today: the port was held by another process). It is a
 * settled failure — nothing deployed, the artifact is gone — so the only thing
 * that makes it different from `failed` is that there is a next step.
 *
 * These pin the two ways it used to disappear:
 *   1. `getProjectStatus` derived "needs attention" purely from the ACTIVE
 *      deployment, and a blocked deploy never becomes active — so the project
 *      rendered a green "Live" (or a "draft" + Deploy-now CTA on a first deploy)
 *      with no hint that the newest deploy was stuck.
 *   2. The deployments list had no case for it, so it fell to the `default:`
 *      arm and rendered as a warning-toned "Pending" — and, being neither
 *      "failed" nor "success", it vanished from the Failed filter and the
 *      failure count, quietly inflating the success rate.
 */

const deployment = (over: Partial<Deployment>): Deployment =>
  ({
    id: "d1",
    version: 1,
    status: "failed",
    domain: "",
    framework: "",
    commit: { hash: "abc1234", message: "m", author: "a", timestamp: "2026-07-31T00:00:00Z" },
    buildTime: null,
    createdAt: "2026-07-31T00:00:00Z",
    type: "git",
    environment: "production",
    ...over,
  }) as Deployment;

describe("getProjectStatus — a blocked deploy needs attention", () => {
  it("reports attention when the latest deploy is blocked, even though a release is live", () => {
    // The case the active-deployment-derived flags structurally cannot see.
    expect(
      getProjectStatus({ activeDeploymentId: "dep-live", latestDeploymentBlocked: true }),
    ).toBe("attention");
  });

  it("reports attention from the status alone, for a project that never deployed", () => {
    // Without this arm the switch falls to `default: "draft"` — a Deploy-now CTA
    // on a project whose first deploy is sitting blocked.
    expect(getProjectStatus({ latestDeploymentStatus: "action_required" })).toBe("attention");
  });

  it("still reports live when a release is live and nothing is blocked", () => {
    expect(getProjectStatus({ activeDeploymentId: "dep-live" })).toBe("live");
  });

  it("does not let a blocked deploy mask an in-flight one", () => {
    // A new deploy already building outranks the previous blocker.
    expect(
      getProjectStatus({ latestDeploymentStatus: "building", latestDeploymentBlocked: true }),
    ).toBe("building");
  });

  it("keeps the existing attention triggers working", () => {
    expect(getProjectStatus({ activeDeploymentId: "d", awaitingDecision: true })).toBe("attention");
    expect(getProjectStatus({ activeDeploymentId: "d", routingUnsynced: true })).toBe("attention");
  });
});

describe("getProjectStatus — a failed latest deploy is never Live", () => {
  it("reports failed when the only deploy failed", () => {
    expect(getProjectStatus({ latestDeploymentId: "d1", latestDeploymentStatus: "failed" })).toBe(
      "failed",
    );
  });

  it("reports failed when the failed deploy is somehow also the live pointer", () => {
    // Shouldn't happen (a failure never advances the pointer) but if it does,
    // "live" is the one answer that is definitely wrong.
    expect(
      getProjectStatus({
        activeDeploymentId: "d1",
        latestDeploymentId: "d1",
        latestDeploymentStatus: "failed",
      }),
    ).toBe("failed");
  });

  it("reports attention — not live — when an older release serves and the newest deploy failed", () => {
    // The site IS up, so "failed" would be a lie; the newest deploy died, so
    // "live" hides it. Same signal the other operator-needed states use.
    expect(
      getProjectStatus({
        activeDeploymentId: "d1",
        latestDeploymentId: "d2",
        latestDeploymentStatus: "failed",
      }),
    ).toBe("attention");
  });

  it("reports attention for a failed latest even when the caller omits latestDeploymentId", () => {
    // Environment summaries pass activeDeploymentId + status only. A failure
    // never advances the pointer, so a set pointer means an older release.
    expect(getProjectStatus({ activeDeploymentId: "d1", latestDeploymentStatus: "failed" })).toBe(
      "attention",
    );
  });

  it("keeps a blocked latest at attention even with a live release", () => {
    expect(
      getProjectStatus({ activeDeploymentId: "d1", latestDeploymentStatus: "action_required" }),
    ).toBe("attention");
  });

  it("still reports live for the self-app, which has no deployment at all", () => {
    expect(getProjectStatus({ appTemplateId: "openship", latestDeploymentStatus: "failed" })).toBe(
      "live",
    );
  });
});

describe("projectDisplayDomain — only a persisted route", () => {
  it("returns nothing when the project has no route", () => {
    // Was `<slug>.<baseDomain>`: the Apps list advertised "convex.opsh.io" for a
    // project whose Domains page correctly said "No domain".
    expect(projectDisplayDomain({})).toBeNull();
    expect(projectDisplayDomain({ primaryDomain: null })).toBeNull();
    expect(projectDisplayDomain({ primaryDomain: "   " })).toBeNull();
  });

  it("returns the persisted primary route", () => {
    expect(projectDisplayDomain({ primaryDomain: "convex.example.com" })).toBe(
      "convex.example.com",
    );
  });
});

describe("deployments list — a blocked deploy is visible and counted", () => {
  it("gets its own chip instead of falling through to Pending", () => {
    const config = getStatusConfig("action_required");
    expect(config.label).toBe("Action required");
    // Amber, matching the project card's Action Required badge — not the red of a
    // dead end, and not the neutral of a cancelled deploy.
    expect(config.color).toBe("var(--color-warning)");
  });

  it("appears under the Failed filter — it did not ship", () => {
    const rows = [
      deployment({ id: "blocked", status: "action_required" }),
      deployment({ id: "ok", status: "success" }),
    ];
    const failed = filterDeployments(rows, { status: "failed" });
    expect(failed.map((d) => d.id)).toEqual(["blocked"]);
  });

  it("counts toward the failed stat, so the success rate stays honest", () => {
    const stats = calculateDeploymentStats([
      deployment({ id: "blocked", status: "action_required" }),
      deployment({ id: "dead", status: "failed" }),
      deployment({ id: "ok", status: "success" }),
    ]);
    expect(stats.failed).toBe(2);
    expect(stats.success).toBe(1);
  });
});

/**
 * A project the operator PAUSED must not read "Live".
 *
 * Pausing stops containers; it does not touch the deployment row. So every
 * surface that derives its pill from the deployment — the cards, the sidebar, the
 * home list — reported a green "Live" over a project serving nothing, which is
 * also why a pause looked like it had failed.
 *
 * `enabled` is server-derived from `disabled_at` in enrichProject, so this one
 * derivation fixes all of those surfaces at once.
 */
describe("getProjectStatus — paused", () => {
  const paused = { enabled: false, activeDeploymentId: "d1", latestDeploymentStatus: "ready" };

  it("reads paused, not live", () => {
    expect(getProjectStatus(paused)).toBe("paused");
  });

  it("is unaffected when the field is absent — old payloads read exactly as before", () => {
    expect(getProjectStatus({ activeDeploymentId: "d1", latestDeploymentStatus: "ready" })).toBe(
      "live",
    );
    expect(
      getProjectStatus({
        enabled: true,
        activeDeploymentId: "d1",
        latestDeploymentStatus: "ready",
      }),
    ).toBe("live");
  });

  it("yields to an in-flight deploy — a redeploy of a paused project is news", () => {
    expect(getProjectStatus({ ...paused, latestDeploymentStatus: "building" })).toBe("building");
    expect(getProjectStatus({ ...paused, latestDeploymentStatus: "deploying" })).toBe("deploying");
  });

  it("yields to teardown, which outranks a pause", () => {
    expect(getProjectStatus({ ...paused, deletionInProgress: true })).toBe("deleting");
  });

  it("never applies to the control plane, which cannot be paused", () => {
    expect(getProjectStatus({ ...paused, appTemplateId: "openship" })).toBe("live");
  });

  it("wins over a paused project's stale deploy flags, so the pill matches what the operator did", () => {
    expect(getProjectStatus({ ...paused, routingUnsynced: true })).toBe("paused");
    expect(getProjectStatus({ ...paused, awaitingDecision: true })).toBe("paused");
  });

  it("has presentation + a localized label like every other status", () => {
    expect(PROJECT_STATUS_META.paused).toBeDefined();
    expect(projectStatusLabel("paused", en as never)).toBe("Paused");
  });
});

/**
 * A live migration, as the project payload reports it (`activeMigration`).
 *
 * The point of putting it here — in the shared status source — is that a project being moved
 * to another server is a fact about the PROJECT, so every surface that renders one reads it
 * from the payload it already loads. Before this, only the project's own Advanced tab knew,
 * because only that panel asked the migration API, and only while it was mounted.
 */
describe("a project with a live migration", () => {
  const migrating = (status: string, mode = "project_move") => ({
    activeMigration: { id: "dmr_1", status, mode },
  });
  // A healthy, serving project — so every assertion below is the migration overriding
  // something that would otherwise read "Live".
  const live = { enabled: true, activeDeploymentId: "d1", latestDeploymentStatus: "ready" };

  it("reads Migrating through every phase that is making progress", () => {
    for (const status of [
      "queued",
      "adopting",
      "moving_data",
      "deploying",
      "verifying",
      "cutover",
    ]) {
      expect(getProjectStatus({ ...live, ...migrating(status) }), status).toBe("migrating");
    }
  });

  it("outranks the target deploy's own status, which says 'deploying' about the copy", () => {
    // The run deploys onto the target, so the project's newest deployment row genuinely reads
    // `deploying`. "Deploying" is true of that deploy and misleading about the project.
    expect(
      getProjectStatus({
        ...live,
        latestDeploymentStatus: "deploying",
        ...migrating("moving_data"),
      }),
    ).toBe("migrating");
  });

  it("outranks a pause, because the run is what is touching the containers now", () => {
    expect(getProjectStatus({ enabled: false, ...migrating("moving_data") })).toBe("migrating");
  });

  it("outranks an unrelated attention flag — one story at a time, the current one", () => {
    expect(getProjectStatus({ ...live, routingUnsynced: true, ...migrating("verifying") })).toBe(
      "migrating",
    );
  });

  it("yields to teardown, the only thing more final than a move", () => {
    expect(
      getProjectStatus({ ...live, deletionInProgress: true, ...migrating("moving_data") }),
    ).toBe("deleting");
  });

  it("reads Action Required — not Migrating — once the run PARKS for the operator", () => {
    // `awaiting_cutover` and `partial` have stopped advancing: the target is up, the source is
    // stopped-but-intact, and it stays that way until a human confirms or rolls back. A pill
    // reading "Migrating" for three days while nothing migrates is the exact bug the other
    // attention states in this module exist to avoid.
    expect(getProjectStatus({ ...live, ...migrating("awaiting_cutover") })).toBe("attention");
    expect(getProjectStatus({ ...live, ...migrating("partial") })).toBe("attention");
  });

  it("reads Action Required when a destructive cutover failed and can only be retried", () => {
    const activeMigration = {
      id: "r",
      status: "cutover",
      mode: "project_move",
      needsAction: true,
    };

    expect(getProjectStatus({ ...live, activeMigration })).toBe("attention");
    expect(getProjectAttentionReason({ ...live, activeMigration })).toBe("migrationCutover");
  });

  it("names the action in the pill's hint, so the amber is not a dead end", () => {
    const hint = projectStatusHint({ ...live, ...migrating("awaiting_cutover") }, en as never);
    expect(hint).toBe(en.projects.migrationAwaitingHint);
    expect(getProjectAttentionReason({ ...live, ...migrating("partial") })).toBe(
      "migrationCutover",
    );
  });

  it("stops overriding anything the moment the run is terminal (payload drops the field)", () => {
    expect(getProjectStatus({ ...live, activeMigration: null })).toBe("live");
    expect(getProjectStatus(live)).toBe("live");
  });

  it("applies to a DUPLICATE too — its source is briefly stopped while volumes stream", () => {
    expect(getProjectStatus({ ...live, ...migrating("moving_data", "project_copy") })).toBe(
      "migrating",
    );
  });

  it("exposes the parked question, so a panel need not re-list the phases", () => {
    // Two copies of "which phases are parked" would drift, and the symptom would be a card
    // calling a run "in progress" beside a pill saying it needs attention.
    expect(
      migrationNeedsOperator({ id: "r", status: "awaiting_cutover", mode: "project_move" }),
    ).toBe(true);
    expect(migrationNeedsOperator({ id: "r", status: "partial", mode: "project_move" })).toBe(true);
    expect(migrationNeedsOperator({ id: "r", status: "moving_data", mode: "project_move" })).toBe(
      false,
    );
    expect(migrationNeedsOperator(null)).toBe(false);
    expect(migrationNeedsOperator(undefined)).toBe(false);
  });

  it("has presentation + a localized label like every other status", () => {
    expect(PROJECT_STATUS_META.migrating).toBeDefined();
    // NOT amber: an advancing run needs nothing from the operator.
    expect(PROJECT_STATUS_META.migrating.badge).not.toContain("warning");
    expect(projectStatusLabel("migrating", en as never)).toBe("Migrating");
  });
});
