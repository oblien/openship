import { expect, it, vi } from "vitest";
import { createSessionManager } from "../src/deployments/session-manager";

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
