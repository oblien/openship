import { expect, it, vi } from "vitest";
import { createSessionManager } from "../src/deployments/session-manager";

it("replays live verification after log trimming without emitting terminal success", () => {
  const manager = createSessionManager();
  try {
    manager.createSession("attempt", "project");
    manager.updateStatus("attempt", "deploying");
    const live = vi.fn((_event: string, _data: string) => true);
    manager.subscribe("attempt", live);
    const verification = { startedAt: new Date().toISOString(), urls: ["https://example.test"] };
    manager.appendLog("attempt", { timestamp: verification.startedAt, message: "Verifying", level: "info",
      step: "verify", stepStatus: "running", verification });
    manager.appendLog("attempt", { timestamp: verification.startedAt, message: "Cleanup", level: "info",
      step: "deploy", stepStatus: "completed" });
    expect(JSON.parse(live.mock.calls.at(-1)![1])).toMatchObject({ currentStep: 5, verification });
    manager.getSession("attempt")!.logs.length = 0;
    const replay = vi.fn((_event: string, _data: string) => true);
    manager.subscribe("attempt", replay);
    expect(JSON.parse(replay.mock.calls.find(([event]) => event === "progress")![1]))
      .toMatchObject({ currentStep: 5, progress: 90, verification });
    expect(replay.mock.calls.some(([event]) => event === "complete")).toBe(false);
    manager.updateStatus("attempt", "failed", { errorMessage: "Startup failed" });
    expect(JSON.parse(replay.mock.calls.find(([event]) => event === "complete")![1])).toMatchObject({ success: false });
  } finally { manager.close(); }
});

it.each(["ready", "failed"] as const)(
  "replays the same %s resource recovery as live completion",
  (status) => {
    const manager = createSessionManager();
    try {
      manager.createSession("attempt", "project");
      const live = vi.fn((_event: string, _data: string) => true);
      manager.subscribe("attempt", live);
      const meta = {
        errorCode: "DEPLOYMENT_RESOURCE_FAILURE",
        errorDetails: { resourceIssue: "storage-full", workspaceId: "space", projectId: "project" },
        ...(status === "ready"
          ? { decisionPending: true, warningMessage: "One service failed" }
          : { errorMessage: "No space left on device" }),
      };
      manager.updateStatus("attempt", status, meta);
      const replay = vi.fn((_event: string, _data: string) => true);
      manager.subscribe("attempt", replay);
      const liveComplete = live.mock.calls.find(([event]) => event === "complete")!;
      const replayComplete = replay.mock.calls.find(([event]) => event === "complete")!;
      expect(JSON.parse(liveComplete[1])).toMatchObject({
        success: status === "ready",
        errorCode: meta.errorCode,
        errorDetails: meta.errorDetails,
      });
      expect(replayComplete).toEqual(liveComplete);
    } finally {
      manager.close();
    }
  },
);
