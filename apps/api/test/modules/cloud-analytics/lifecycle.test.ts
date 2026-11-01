import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ capture: vi.fn(), outcome: vi.fn(), enabled: vi.fn(() => true) }));
vi.mock("@repo/platform/engine/modules/cloud-analytics/index", () => ({
  cloudAnalytics: { capture: h.capture, deploymentOutcome: h.outcome, enabled: h.enabled },
}));
import {
  observeCloudAudit,
  observeCloudNotification,
} from "@repo/platform/engine/modules/cloud-analytics/lifecycle";
const ctx = { organizationId: "org", actorUserId: "user" };
beforeEach(() => {
  vi.clearAllMocks();
  h.enabled.mockReturnValue(true);
});
describe("projection of shared lifecycle events", () => {
  it("only projects successful application facts, without audit secrets or runtime logs", () => {
    observeCloudAudit(ctx, {
      eventType: "project.created",
      resourceId: "project",
      after: { env: { PASSWORD: "secret" }, repo: "private" },
    });
    observeCloudAudit(ctx, {
      eventType: "deployment.failed",
      resourceId: "dep",
      after: {
        projectId: "project",
        errorMessage: "password secret",
        branch: "private",
        durationMs: 20,
      },
    });
    observeCloudNotification({
      organizationId: "org",
      eventType: "backup_run.succeeded",
      resourceId: "backup",
      payload: { bytesTransferred: 1000, destinationName: "private" },
    });
    expect(h.capture).toHaveBeenCalledWith(
      expect.anything(),
      "cloud_project_created",
      { project_id: "project" },
      "project:project",
    );
    expect(h.outcome).toHaveBeenCalledWith(expect.anything(), false, {
      project_id: "project",
      deployment_id: "dep",
      duration_ms: 20,
    });
    expect(h.capture).toHaveBeenCalledWith(
      expect.anything(),
      "cloud_backup_completed",
      { backup_id: "backup", bytes: 1000 },
      "backup:backup:succeeded",
    );
    expect(JSON.stringify([h.capture.mock.calls, h.outcome.mock.calls])).not.toMatch(
      /secret|private|PASSWORD/,
    );
  });
  it("does not count project updates/ensures, unverified GitHub connects, or unrelated notifications as creation", () => {
    observeCloudAudit(ctx, {
      eventType: "project.updated",
      resourceId: "project",
      after: { name: "changed" },
    });
    observeCloudAudit(ctx, { eventType: "github.connect", resourceId: "*" });
    observeCloudNotification({
      organizationId: "org",
      eventType: "deployment.succeeded",
      resourceId: "dep",
    });
    expect(h.capture).not.toHaveBeenCalled();
    expect(h.outcome).not.toHaveBeenCalled();
  });
  it("tracks enabled token, scaling and backup policy adoption at their shared boundaries", () => {
    observeCloudAudit(ctx, {
      eventType: "settings.updated",
      resourceId: "user",
      after: { action: "cloneCredentials.set", asDefault: false },
    });
    expect(h.capture).not.toHaveBeenCalled();
    observeCloudAudit(ctx, {
      eventType: "settings.updated",
      resourceId: "user",
      after: { action: "cloneCredentials.set", asDefault: true },
    });
    observeCloudAudit(ctx, {
      eventType: "project.updated",
      resourceId: "project",
      after: { action: "cluster.replicas", replicas: 3 },
    });
    observeCloudAudit(ctx, {
      eventType: "backup_destination:backup_policy:write",
      resourceType: "backup_policy",
      resourceId: "policy",
      after: { operation: "create" },
    });
    expect(h.capture.mock.calls.map((call) => call[1])).toEqual([
      "cloud_github_connected",
      "cloud_scaling_configured",
      "cloud_backup_policy_created",
    ]);
  });
});
