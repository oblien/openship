import { describe, expect, it } from "vitest";

import { getProjectStatus } from "./project-status";
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
