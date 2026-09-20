import { describe, expect, it, vi } from "vitest";
import type { DeploymentBuildStatus, DeploymentEvent, DeploymentOperations } from "@repo/contracts";
import { consumeDeploymentEvents, createDeploymentHandle } from "../src/deployment-handle";

const status = (patch: Partial<DeploymentBuildStatus> = {}): DeploymentBuildStatus => ({
  success: true, deployment_id: "dep-a", project_id: "project-a", status: "building",
  deploymentStatus: "building", is_active: true, cancellationPending: false,
  decisionPending: false, pendingPrompt: null, ...patch,
});
function setup() {
  const buildStatus = vi.fn(async () => status());
  const respond = vi.fn(async () => ({ success: true }));
  const cancel = vi.fn();
  const handle = createDeploymentHandle({ buildStatus, respond, cancel } as unknown as DeploymentOperations, "dep-a");
  return { buildStatus, respond, cancel, handle };
}

describe("deployment handles", () => {
  it("uses the persisted outcome when the session reports ready for a partial failure", async () => {
    const s = setup();
    s.buildStatus.mockResolvedValue(status({ status: "ready", deploymentStatus: "partial_failure", decisionPending: true, is_active: false }));
    await expect(s.handle.wait()).resolves.toMatchObject({ status: "partial_failure", success: false, decisionPending: true });
  });

  it("waits for cancellation cleanup before returning a cancelled outcome", async () => {
    const s = setup();
    s.buildStatus.mockResolvedValueOnce(status({ status: "cancelled", deploymentStatus: "cancelled", cancellationPending: true }))
      .mockResolvedValueOnce(status({ status: "cancelled", deploymentStatus: "cancelled", cancellationPending: false }));
    await expect(s.handle.wait({ pollIntervalMs: 10 })).resolves.toMatchObject({ status: "cancelled", cancellationPending: false });
    expect(s.buildStatus).toHaveBeenCalledTimes(2);
  });

  it("returns an actionable prompt without guessing a response", async () => {
    const s = setup();
    const prompt = { promptId: "p", title: "Port conflict", message: "Choose", actions: [{ id: "abort", label: "Abort" }] };
    s.buildStatus.mockResolvedValue(status({ pendingPrompt: prompt }));
    await expect(s.handle.wait()).resolves.toMatchObject({ status: "action_required", prompt, success: false });
    expect(s.respond).not.toHaveBeenCalled();
  });

  it("validates callback decisions against the offered prompt actions", async () => {
    const s = setup();
    const prompt = { promptId: "p", title: "Choose", message: "Choose", actions: [{ id: "retry", label: "Retry" }] };
    s.buildStatus.mockResolvedValue(status({ pendingPrompt: prompt }));
    await expect(s.handle.wait({ onPrompt: () => "invented" })).rejects.toMatchObject({ code: "INVALID_PROMPT_ACTION" });
    expect(s.respond).not.toHaveBeenCalled();
    s.buildStatus.mockResolvedValueOnce(status({ pendingPrompt: prompt }))
      .mockResolvedValueOnce(status({ status: "ready", deploymentStatus: "no_changes", is_active: false }));
    await expect(s.handle.wait({ onPrompt: () => "retry", pollIntervalMs: 10 })).resolves.toMatchObject({ status: "no_changes", success: true });
    expect(s.respond).toHaveBeenCalledExactlyOnceWith("dep-a", { action: "retry" });
  });

  it("cancels waiting even during a stalled read without cancelling the deployment", async () => {
    const s = setup();
    s.buildStatus.mockReturnValue(new Promise(() => {}));
    const abort = new AbortController();
    const waiting = s.handle.wait({ signal: abort.signal });
    abort.abort(new Error("Caller stopped waiting"));
    await expect(waiting).rejects.toThrow("Caller stopped waiting");
    expect(s.cancel).not.toHaveBeenCalled();
  });

  it("decodes base64 terminal bytes across UTF-8 chunks and retains partial service failures", async () => {
    const bytes = Buffer.from("مرحبا\n");
    const events: DeploymentEvent[] = [
      { event: "log", data: JSON.stringify({ serviceId: "web", data: bytes.subarray(0, 3).toString("base64") }) },
      { event: "log", data: JSON.stringify({ serviceId: "other", data: Buffer.from("other\n").toString("base64") }) },
      { event: "log", data: JSON.stringify({ serviceId: "web", data: bytes.subarray(3).toString("base64") }) },
      { event: "service-status", data: JSON.stringify({ serviceId: "other", serviceName: "worker", status: "failed" }) },
      { event: "complete", data: JSON.stringify({ success: true }) },
      { event: "end", data: JSON.stringify({ status: "ready" }) },
    ];
    const text: Record<string, string> = {};
    async function* stream() { yield* events; }
    const result = await consumeDeploymentEvents(stream(), (event) => {
      if (event.log) { const key = String(event.payload.serviceId); text[key] = (text[key] ?? "") + event.log; }
    });
    expect(text).toEqual({ web: "مرحبا\n", other: "other\n" });
    expect(result).toMatchObject({ completed: true, success: false, failedServices: [{ id: "other", name: "worker" }] });
  });

  it("does not claim completion after an interrupted event stream", async () => {
    async function* stream() { yield { event: "complete", data: JSON.stringify({ success: true }) }; }
    expect((await consumeDeploymentEvents(stream())).completed).toBe(false);
  });
});
