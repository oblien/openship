import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  destroy: vi.fn(async () => {}),
  updateStatus: vi.fn(async () => true),
}));

// The lifecycle module transitively pulls in auth/notification wiring that reads
// `schema` at import time; only the shape matters here, never the contents.
vi.mock("@repo/db", () => ({
  schema: { user: {}, organization: {}, member: {} },
  repos: {
    deployment: {
      updateStatus: mocks.updateStatus,
      supersedePendingDecisions: vi.fn(async () => {}),
      setContainerId: vi.fn(async () => {}),
      findBuildSessionById: vi.fn(async () => null),
      appendBuildLog: vi.fn(async () => {}),
      finishBuildSession: vi.fn(async () => {}),
    },
    project: { setActiveDeployment: vi.fn(async () => {}) },
    service: { listByDeployment: vi.fn(async () => []) },
  },
}));
vi.mock("../../../src/lib/notification-dispatcher", () => ({
  notification: { emit: vi.fn() },
}));
vi.mock("../../../src/lib/audit", () => ({ audit: { recordAsync: vi.fn(), record: vi.fn() } }));
vi.mock("../../../src/lib/favicon-detector", () => ({
  detectAndStoreFavicon: vi.fn(async () => {}),
}));
vi.mock("../../../src/modules/mail/webmail/webmail-install.service", () => ({
  onWebmailDeployed: vi.fn(async () => {}),
}));
vi.mock("../../../src/modules/deployments/session-manager", () => ({
  updateStatus: vi.fn(),
  broadcastServiceStatus: vi.fn(),
  broadcastInstallPhase: vi.fn(),
  getSession: vi.fn(() => null),
  endSession: vi.fn(),
}));

import { onCancelled, onFailure } from "../../../src/modules/deployments/deployment-lifecycle";

/**
 * `ctx.provisioned.imageRef` is a RECLAIM LIST, not a record of what got deployed:
 * its only readers are onFailure and onCancelled, and both destroy it. So what goes
 * on it decides what a failed deploy deletes.
 *
 * A rollback that reuses a retained artifact put the artifact it was RESTORING on
 * that list, so any transient failure on the way — the health gate, a route apply, a
 * dropped SSH — destroyed the release it was restoring. For a static release that is
 * an `rm -rf` of `releases/<depId>`: the retryable rollback came back ARTIFACT_GONE
 * and a release with no commit (upload / localPath) became permanently un-restorable.
 *
 * The reclaim itself is correct and stays; the gate is in the pipeline, which is why
 * it is pinned here as source. A behaviour-only suite passes either way — the hazard
 * is what the caller CHOOSES to record.
 */

const ctx = (provisioned: { imageRef?: string }) =>
  ({
    runtime: { name: "bare", destroy: mocks.destroy },
    project: { id: "p1", name: "app", slug: "app" },
    dep: {
      id: "d_new",
      projectId: "p1",
      organizationId: "org1",
      branch: "main",
      commitSha: null,
      meta: null,
    },
    buildSessionId: "bld_x",
    provisioned,
    persistLogs: () => [],
    logs: [],
  }) as never;

const RELEASE_DIR = "/opt/openship/static/releases/d_old";

describe("a reused artifact is not on the failure reclaim list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("onFailure destroys whatever the pipeline recorded — including a release dir", async () => {
    await onFailure(ctx({ imageRef: RELEASE_DIR }), "health gate failed");
    expect(mocks.destroy).toHaveBeenCalledWith(RELEASE_DIR);
  });

  it("onCancelled destroys it too", async () => {
    await onCancelled(ctx({ imageRef: RELEASE_DIR }), 10);
    expect(mocks.destroy).toHaveBeenCalledWith(RELEASE_DIR);
  });

  it("neither hook reclaims anything when nothing was recorded", async () => {
    await onFailure(ctx({}), "health gate failed");
    await onCancelled(ctx({}), 10);
    expect(mocks.destroy).not.toHaveBeenCalled();
  });

  it("the pipeline records ONLY an artifact this deploy produced", () => {
    const src = readFileSync(
      resolve(import.meta.dirname, "../../../src/modules/deployments/build-pipeline.ts"),
      "utf8",
    );
    // The one assignment, gated on the reuse. An ungated `provisioned.imageRef =`
    // anywhere on this path puts a PINNED artifact back on the reclaim list.
    const assignments = src.match(/provisioned\.imageRef\s*=/g) ?? [];
    expect(assignments).toHaveLength(1);
    expect(src).toMatch(
      /if \(!reusedArtifact && buildResult\.artifactOwned !== false\) \{\s*provisioned\.imageRef = buildResult\.imageRef;\s*\}/,
    );
  });

  it("a refresh fails closed when its active artifact is gone", () => {
    const src = readFileSync(
      resolve(import.meta.dirname, "../../../src/modules/deployments/build-pipeline.ts"),
      "utf8",
    );
    const refreshStart = src.indexOf("const refreshFrom = refreshAppDeploymentId(snapshot)");
    const ordinaryPinStart = src.indexOf(
      "const image = pinnedAppImage(snapshot)",
      refreshStart + 1,
    );
    const refreshBranch = src.slice(refreshStart, ordinaryPinStart);

    expect(refreshStart).toBeGreaterThan(-1);
    expect(ordinaryPinStart).toBeGreaterThan(refreshStart);
    expect(refreshBranch).toContain("Cannot refresh without rebuilding");
    expect(refreshBranch).toContain("Use Redeploy instead");
    expect(refreshBranch).not.toContain("return gone(");
  });
});
