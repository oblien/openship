import { afterEach, describe, expect, it, vi } from "vitest";
import type { Oblien } from "oblien";
import { cloudWorkspaceStatus, waitForCloudDockerWorkspace } from "./workspace-ready";

afterEach(() => vi.useRealTimers());
describe("Docker workspace readiness", () => {
  it.each([{ status: "active", info: { status: "running" } }, { status: "running" }])("waits for provisioning before accepting %j", async state => {
    vi.useFakeTimers();
    const get = vi.fn().mockResolvedValueOnce({ namespace: "tenant", ...state, ready: false, provisioning: { state: "running" } })
      .mockResolvedValue({ namespace: "tenant", ...state, ready: true, provisioning: { state: "ready" } });
    const waiting = waitForCloudDockerWorkspace({ workspaces: { get } } as unknown as Oblien, "owned-vm", "tenant");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(waiting).resolves.toMatchObject({ ready: true });
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenLastCalledWith("owned-vm");
  });
  it("uses the live VM state even while the workspace record remains active", async () => {
    const get = vi.fn().mockResolvedValue({ namespace: "tenant", status: "active", info: { status: "stopped" }, provisioning: { state: "ready" } });
    await expect(waitForCloudDockerWorkspace({ workspaces: { get } } as unknown as Oblien, "vm", "tenant", { timeoutMs: 0 })).rejects.toThrow("still starting");
    expect(cloudWorkspaceStatus({ status: "active", info: { is_running: false } })).toBe("stopped");
    expect(cloudWorkspaceStatus({ status: "active", info: { is_running: true } })).toBe("running");
  });
  it("rejects a changed namespace even when the VM is ready", async () => {
    const get = vi.fn().mockResolvedValue({ namespace: "other-tenant", status: "active", ready: true });
    await expect(waitForCloudDockerWorkspace({ workspaces: { get } } as unknown as Oblien, "vm", "tenant")).rejects.toThrow("namespace");
  });
  it("surfaces a failed provisioning attempt without creating a replacement", async () => {
    const get = vi.fn().mockResolvedValue({ namespace: "tenant", status: "error", provisioning: { state: "failed" } });
    await expect(waitForCloudDockerWorkspace({ workspaces: { get } } as unknown as Oblien, "vm", "tenant")).rejects.toThrow("existing disk");
  });
  it("cancels the wait before another provider read", async () => {
    const get = vi.fn();
    await expect(waitForCloudDockerWorkspace({ workspaces: { get } } as unknown as Oblien, "vm", "tenant", { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
  });
});
