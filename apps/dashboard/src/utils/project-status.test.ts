import { describe, expect, it } from "vitest";

import type { Dictionary } from "@/i18n";

import {
  getProjectStatus,
  PROJECT_STATUS_META,
  projectStatusLabel,
  type ProjectStatus,
} from "./project-status";

describe("getProjectStatus", () => {
  it("falls through to draft when nothing is set", () => {
    // No signals at all -> the final default branch, not any earlier one.
    expect(getProjectStatus({})).toBe("draft");
  });

  it("reports deleting when deletedAt is set", () => {
    expect(getProjectStatus({ deletedAt: "2024-01-01T00:00:00Z" })).toBe("deleting");
  });

  it("reports deleting when deletionInProgress is the real in-progress flag", () => {
    // Per the source comment, teardown hard-deletes on success, so deletedAt
    // is rarely set; deletionInProgress is what actually drives this case.
    expect(getProjectStatus({ deletionInProgress: true })).toBe("deleting");
  });

  it("deleting beats the openship self-app check", () => {
    // deletedAt/deletionInProgress is checked first in the source, so even the
    // control-plane self-app must show "deleting" if it's being torn down.
    expect(getProjectStatus({ deletionInProgress: true, appTemplateId: "openship" })).toBe(
      "deleting",
    );
  });

  it("reports the openship self-app as live even mid-build", () => {
    // The self-app IS the running host process and has no deployment record
    // behind it; the source deliberately checks appTemplateId before the
    // latestDeploymentStatus switch, so a "building" self-app must still be "live".
    expect(
      getProjectStatus({ appTemplateId: "openship", latestDeploymentStatus: "building" }),
    ).toBe("live");
  });

  it("reports the openship self-app as live with no deployment info at all", () => {
    expect(getProjectStatus({ appTemplateId: "openship" })).toBe("live");
  });

  it.each(["queued", "building", "deploying"] as const)(
    "surfaces an in-progress latestDeploymentStatus of %s directly",
    (status) => {
      expect(getProjectStatus({ latestDeploymentStatus: status })).toBe(status);
    },
  );

  it("an in-progress deployment status beats awaitingDecision", () => {
    // The latestDeploymentStatus switch runs before the awaitingDecision check,
    // so a project mid-build must show "building", not "attention".
    expect(getProjectStatus({ latestDeploymentStatus: "building", awaitingDecision: true })).toBe(
      "building",
    );
  });

  it("an in-progress deployment status beats routingUnsynced", () => {
    expect(getProjectStatus({ latestDeploymentStatus: "deploying", routingUnsynced: true })).toBe(
      "deploying",
    );
  });

  it("awaitingDecision beats activeDeploymentId, never rendering green live", () => {
    // A partial-failure deploy awaiting keep/reject must surface "Action
    // Required", even though there's a perfectly live activeDeploymentId.
    expect(getProjectStatus({ activeDeploymentId: "dep_1", awaitingDecision: true })).toBe(
      "attention",
    );
  });

  it("routingUnsynced beats activeDeploymentId too", () => {
    // Same "Action Required" guarantee, but for the distinct free-domain
    // edge-route-didn't-sync case (separate Retry-routing action).
    expect(getProjectStatus({ activeDeploymentId: "dep_1", routingUnsynced: true })).toBe(
      "attention",
    );
  });

  it("activeDeploymentId reports live on its own", () => {
    expect(getProjectStatus({ activeDeploymentId: "dep_1" })).toBe("live");
  });

  it("activeDeploymentId beats a failed latest status", () => {
    // A project can have a good active release plus a newer failed deploy
    // attempt; it must still report "live", not "failed".
    expect(
      getProjectStatus({ activeDeploymentId: "dep_1", latestDeploymentStatus: "failed" }),
    ).toBe("live");
  });

  it("activeDeploymentId beats a cancelled latest status", () => {
    expect(
      getProjectStatus({ activeDeploymentId: "dep_1", latestDeploymentStatus: "cancelled" }),
    ).toBe("live");
  });

  it("reports failed when there is no active deployment to fall back on", () => {
    expect(getProjectStatus({ latestDeploymentStatus: "failed" })).toBe("failed");
  });

  it("reports cancelled when there is no active deployment to fall back on", () => {
    expect(getProjectStatus({ latestDeploymentStatus: "cancelled" })).toBe("cancelled");
  });

  it("falls through to draft for an unrecognized latestDeploymentStatus with no active deployment", () => {
    expect(getProjectStatus({ latestDeploymentStatus: "something-else" })).toBe("draft");
  });
});

describe("projectStatusLabel", () => {
  it("reads the label from the dictionary's projects.status map", () => {
    const fakeDictionary = {
      projects: {
        status: {
          live: "Live",
          attention: "Action Required",
          queued: "Queued",
          building: "Building",
          deploying: "Deploying",
          failed: "Failed",
          cancelled: "Cancelled",
          deleting: "Deleting",
          draft: "Draft",
        },
      },
    } as unknown as Dictionary;

    expect(projectStatusLabel("attention", fakeDictionary)).toBe("Action Required");
    expect(projectStatusLabel("live", fakeDictionary)).toBe("Live");
  });
});

describe("PROJECT_STATUS_META", () => {
  // Exhaustiveness guard: every ProjectStatus value must have non-empty styling,
  // so adding a new status without wiring up its badge/dot fails loudly instead
  // of silently rendering blank CSS classes.
  //
  // Keyed as a Record<ProjectStatus, true> rather than a plain array on purpose.
  // An array would silently drift: adding a member to the ProjectStatus union
  // would leave this list stale and the test would keep passing. The Record
  // makes TypeScript itself reject an incomplete list, so `tsc --noEmit` fails
  // the moment a new status is added without being covered here.
  const STATUS_COVERAGE: Record<ProjectStatus, true> = {
    live: true,
    attention: true,
    queued: true,
    building: true,
    deploying: true,
    failed: true,
    cancelled: true,
    deleting: true,
    draft: true,
  };

  const allStatuses = Object.keys(STATUS_COVERAGE) as ProjectStatus[];

  it.each(allStatuses)("has non-empty badge and dot classes for %s", (status) => {
    const meta = PROJECT_STATUS_META[status];
    expect(meta).toBeDefined();
    expect(meta.badge.length).toBeGreaterThan(0);
    expect(meta.dot.length).toBeGreaterThan(0);
  });
});
