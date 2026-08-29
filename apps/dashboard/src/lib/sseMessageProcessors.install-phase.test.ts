import { describe, expect, it, vi } from "vitest";
import { createBuildMessageProcessor } from "./sseMessageProcessors";

/**
 * The install-phase event shares the build processor with the other deploy UI.
 * The contract: it routes to onInstallPhase and NEVER to the legacy onPhaseChange
 * catch-all (it carries no top-level `phase` key), and a real `phase` message is
 * unaffected — so the shared processor change is additive.
 */
describe("build processor — install-phase routing", () => {
  it("parses an install-phase event to its own type, not `phase`", () => {
    const p = createBuildMessageProcessor();
    const msg = p.parseMessage({ type: "install-phase", id: "images", status: "active", label: "Preparing images" });
    expect(msg.type).toBe("install-phase");
  });

  it("routes an install-phase event to onInstallPhase and never onPhaseChange", () => {
    const onInstallPhase = vi.fn();
    const onPhaseChange = vi.fn();
    const p = createBuildMessageProcessor({ onInstallPhase, onPhaseChange });

    const msg = p.parseMessage({ type: "install-phase", id: "services", status: "done", label: "Starting services" });
    p.handleMessage(msg, {} as any);

    expect(onInstallPhase).toHaveBeenCalledTimes(1);
    expect(onInstallPhase).toHaveBeenCalledWith({ id: "services", status: "done", label: "Starting services" });
    expect(onPhaseChange).not.toHaveBeenCalled();
  });

  it("still routes a legacy `phase` message to onPhaseChange (no regression)", () => {
    const onInstallPhase = vi.fn();
    const onPhaseChange = vi.fn();
    const p = createBuildMessageProcessor({ onInstallPhase, onPhaseChange });

    const msg = p.parseMessage({ phase: "deploy" });
    expect(msg.type).toBe("phase");
    p.handleMessage(msg, {} as any);

    expect(onPhaseChange).toHaveBeenCalledWith("deploy");
    expect(onInstallPhase).not.toHaveBeenCalled();
  });
});
