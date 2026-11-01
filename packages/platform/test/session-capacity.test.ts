import { describe, expect, it, vi } from "vitest";
import { SYSTEM } from "@repo/core";
import { createSessionManager } from "../src/deployments/session-manager";

describe("deployment session capacity", () => {
  it("keeps live logs and held decisions while pruning completed history", () => {
    const manager = createSessionManager();
    try {
      const live = manager.createSession("live", "project");
      const writer = vi.fn(() => true);
      manager.subscribe("live", writer);
      const held = manager.createSession("held", "project");
      manager.updateStatus("held", "ready", { decisionPending: true });
      for (let i = 2; i < SYSTEM.SSE.MAX_SESSIONS; i++) {
        manager.createSession(`finished-${i}`, "project");
        manager.updateStatus(`finished-${i}`, "ready");
      }
      manager.createSession("next", "project");
      expect(manager.getSession("live")).toBe(live);
      expect(manager.getSession("held")).toBe(held);
      expect(manager.getSession("finished-2")).toBeNull();
      manager.appendLog("live", { timestamp: new Date().toISOString(), message: "Still building", level: "info" });
      expect(writer).toHaveBeenCalledWith("log", expect.stringContaining('"eventId":0'));
    } finally {
      manager.close();
    }
  });

  it("rejects a new session instead of losing existing live operations at capacity", () => {
    const manager = createSessionManager();
    try {
      for (let i = 0; i < SYSTEM.SSE.MAX_SESSIONS; i++) manager.createSession(`live-${i}`, "project");
      expect(() => manager.createSession("excess", "project")).toThrow("all entries are in use");
      expect(manager.getSession("live-0")?.status).toBe("queued");
      expect(manager.getSession("excess")).toBeNull();
    } finally {
      manager.close();
    }
  });
});
