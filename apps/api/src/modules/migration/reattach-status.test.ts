import { describe, it, expect } from "vitest";
import { deriveDeploymentStatus } from "./migrate.service";

// The re-import live re-attach derives the deployment badge from the live
// per-container states (docker inspect). This is the one piece of fabricated
// state, so it must reflect reality: don't claim "ready" when a container is down.
describe("deriveDeploymentStatus (re-import live re-attach)", () => {
  it("all running → ready", () => {
    expect(deriveDeploymentStatus(["running", "running"])).toBe("ready");
  });

  it("some running → partial_failure", () => {
    expect(deriveDeploymentStatus(["running", "stopped"])).toBe("partial_failure");
    expect(deriveDeploymentStatus(["running", "failed", "missing"])).toBe("partial_failure");
  });

  it("none running → failed", () => {
    expect(deriveDeploymentStatus(["stopped", "failed"])).toBe("failed");
    expect(deriveDeploymentStatus(["missing"])).toBe("failed");
  });

  it("empty (no containers) → failed, never a false 'ready'", () => {
    expect(deriveDeploymentStatus([])).toBe("failed");
  });
});
