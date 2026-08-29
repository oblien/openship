import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  updateStatus: vi.fn(),
  setActiveDeployment: vi.fn(async () => {}),
  supersedePendingDecisions: vi.fn(async () => {}),
  sseUpdateStatus: vi.fn(),
  notify: vi.fn(),
  finishBuildSession: vi.fn(async () => {}),
}));

// The lifecycle module transitively pulls in auth/notification wiring that reads
// `schema` at import time; only the shape matters here, never the contents.
vi.mock("@repo/db", () => ({
  schema: { user: {}, organization: {}, member: {} },
  repos: {
    deployment: {
      updateStatus: mocks.updateStatus,
      supersedePendingDecisions: mocks.supersedePendingDecisions,
      setContainerId: vi.fn(async () => {}),
      findReadyVersionByCommit: vi.fn(async () => null),
      getNextReadyVersion: vi.fn(async () => 1),
      findBuildSessionById: vi.fn(async () => null),
      appendBuildLog: vi.fn(async () => {}),
      finishBuildSession: mocks.finishBuildSession,
    },
    project: { setActiveDeployment: mocks.setActiveDeployment },
    service: { listByDeployment: vi.fn(async () => []) },
  },
}));
// Terminal-event side channels, each of which drags in auth/github/mail wiring.
vi.mock("../../lib/notification-dispatcher", () => ({ notification: { emit: mocks.notify } }));
vi.mock("../../lib/audit", () => ({ audit: { recordAsync: vi.fn(), record: vi.fn() } }));
vi.mock("../../lib/favicon-detector", () => ({ detectAndStoreFavicon: vi.fn(async () => {}) }));
vi.mock("../mail/webmail/webmail-install.service", () => ({
  onWebmailDeployed: vi.fn(async () => {}),
}));
vi.mock("./session-manager", () => ({
  updateStatus: mocks.sseUpdateStatus,
  broadcastServiceStatus: vi.fn(),
  broadcastInstallPhase: vi.fn(),
  getSession: vi.fn(() => null),
  endSession: vi.fn(),
}));

import { onFailure, onSuccess, setDeploymentStatus } from "./deployment-lifecycle";

/**
 * A cancel is the user's last word, but cancellation is COOPERATIVE and the deploy
 * phase doesn't check for it at all — so the work a cancel interrupts keeps running
 * and reaches its own success hook. `repos.deployment.updateStatus` refuses to move
 * a row off `cancelled`; these pin that every consumer of that refusal declines to
 * publish a success on top of it. The failure this prevents is silent: the deploy
 * the user stopped goes green and becomes the live release.
 */

const ctx = {
  project: { id: "p1", name: "app", slug: "app" },
  dep: {
    id: "d1",
    projectId: "p1",
    organizationId: "org1",
    branch: "main",
    commitSha: null,
    meta: null,
  },
  buildSessionId: "bld_x",
  provisioned: {},
  // Sync, returning entries — `collectLogs` calls this directly and onFailure's
  // notification tail slices the result. An async stub returns a Promise here and
  // only blows up on the paths that actually read the log tail.
  persistLogs: () => [],
  runtime: null,
  logs: [],
} as never;

describe("a cancelled deployment is final", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("onSuccess does not advance the active release when the row refuses the write", async () => {
    mocks.updateStatus.mockResolvedValue(false);

    await onSuccess(ctx, { containerId: "c1", durationMs: 10 });

    // The pointer is the whole game: advance it and the cancelled build becomes
    // the project's live release.
    expect(mocks.setActiveDeployment).not.toHaveBeenCalled();
    expect(mocks.supersedePendingDecisions).not.toHaveBeenCalled();
    expect(mocks.sseUpdateStatus).not.toHaveBeenCalledWith("d1", "ready", expect.anything());
  });

  it("onSuccess publishes the release normally when the write applied", async () => {
    mocks.updateStatus.mockResolvedValue(true);

    await onSuccess(ctx, { containerId: "c1", durationMs: 10 });

    expect(mocks.setActiveDeployment).toHaveBeenCalledWith("p1", "d1");
  });

  /**
   * The same refusal on the FAILURE side. Cancelling during the deploy phase tears
   * the containers down under the running pipeline, so the pipeline then fails —
   * and `onFailure` used to broadcast `failed` regardless of the row refusing the
   * write. The row said `cancelled` while the stream said `failed`, which is what
   * made the app wizard show "Install failed" underneath "Install cancelled".
   */
  it("onFailure reports the cancel, not a failure, when the row refuses the write", async () => {
    mocks.updateStatus.mockResolvedValue(false);

    await onFailure(ctx, "container exited 1", 10);

    expect(mocks.sseUpdateStatus).not.toHaveBeenCalled();
    expect(mocks.finishBuildSession).toHaveBeenCalledWith(
      "bld_x",
      "cancelled",
      expect.anything(),
      expect.anything(),
    );
    // Nobody lost a deploy they meant to keep — no failure notification.
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("onFailure reports a real failure normally when the write applied", async () => {
    mocks.updateStatus.mockResolvedValue(true);

    await onFailure(ctx, "container exited 1", 10);

    expect(mocks.sseUpdateStatus).toHaveBeenCalledWith(
      "d1",
      "failed",
      expect.objectContaining({ errorMessage: expect.stringContaining("container exited 1") }),
    );
    expect(mocks.notify).toHaveBeenCalled();
  });

  it("setDeploymentStatus does not broadcast a status the DB refused", async () => {
    mocks.updateStatus.mockResolvedValue(false);

    await setDeploymentStatus("d1", "deploying");

    expect(mocks.sseUpdateStatus).not.toHaveBeenCalled();
  });

  it("setDeploymentStatus broadcasts when the write applied", async () => {
    mocks.updateStatus.mockResolvedValue(true);

    await setDeploymentStatus("d1", "deploying");

    expect(mocks.sseUpdateStatus).toHaveBeenCalledWith("d1", "deploying", undefined);
  });
});
