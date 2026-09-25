import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandExecutor } from "@repo/adapters";

const h = vi.hoisted(() => ({
  get: vi.fn(),
  create: vi.fn(),
  createHost: vi.fn(),
}));
vi.mock("@repo/db", () => ({ repos: { server: { get: h.get } } }));
vi.mock("@repo/adapters", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createExecutor: h.create,
  createHostExecutor: h.createHost,
}));
vi.mock("@repo/platform/engine/lib/box-org", () => ({
  isLocalHostRow: async (row: { isLocal?: boolean }) => !!row.isLocal,
}));

import { SshConnectionManager } from "@repo/platform/engine/lib/ssh-manager";

function executor() {
  return {
    exec: vi.fn(async () => "ok"),
    dispose: vi.fn(async () => {}),
    onDisconnect: vi.fn(() => vi.fn()),
  } as unknown as CommandExecutor & { dispose: ReturnType<typeof vi.fn> };
}
const row = (id: string) => ({
  id, isLocal: id.startsWith("local"), sshHost: "192.0.2.1", sshUser: "ubuntu",
  sshAuthMethod: "key", sshPrivateKey: "test-private-key",
});
let manager: SshConnectionManager;
beforeEach(() => {
  vi.resetAllMocks();
  h.get.mockImplementation(async (id: string) => row(id));
  h.create.mockImplementation(executor);
  h.createHost.mockImplementation(executor);
  manager = new SshConnectionManager();
});
afterEach(async () => { await manager.destroy(); });

describe("SSH reachability with per-operation connections", () => {
  it.each([true, false])("only reuses proof while the connection persists: %s", async (persistentConnection) => {
    const remote = Object.assign(executor(), { persistentConnection });
    h.create.mockReturnValue(remote);
    h.get.mockResolvedValue({ ...row("remote"), sshAuthMethod: "agent" });
    await manager.acquire("remote");
    expect(manager.isConnected("remote")).toBe(false);
    expect(await manager.probeReachable("remote")).toBe(true);
    expect(manager.isConnected("remote")).toBe(persistentConnection);
    expect(await manager.probeReachable("remote")).toBe(true);
    expect(remote.exec).toHaveBeenCalledTimes(persistentConnection ? 1 : 2);
  });

  it("reports a failed Windows SSH route even after a successful command", async () => {
    const remote = Object.assign(executor(), { persistentConnection: false });
    h.create.mockReturnValue(remote);
    h.get.mockResolvedValue({ ...row("remote"), sshAuthMethod: "agent", sshTransport: "cloudflare", sshHost: "ssh.example.test" });
    expect(await manager.probeReachable("remote")).toBe(true);
    vi.mocked(remote.exec).mockRejectedValue(new Error("All configured authentication methods failed"));
    expect(await manager.diagnoseReachability("remote")).toMatchObject({ reachable: false, code: "unreachable" });
    expect(remote.exec).toHaveBeenCalledTimes(2);
  });
});

describe("SSH authentication refresh (#408)", () => {
  it("uses the new login for future operations while retaining an active terminal", async () => {
    const old = await manager.acquire("remote");
    manager.retain("remote");
    const fresh = await manager.refreshAuthentication("remote", old);
    expect(fresh).not.toBe(old);
    expect(await manager.acquire("remote")).toBe(fresh);
    expect(old.dispose).not.toHaveBeenCalled();
    manager.release("remote");
    expect(old.dispose).toHaveBeenCalledTimes(1);
    expect(fresh.dispose).not.toHaveBeenCalled();
  });

  it("coalesces simultaneous checks of the same stale login", async () => {
    const old = await manager.acquire("remote");
    const refreshed = await Promise.all([
      manager.refreshAuthentication("remote", old),
      manager.refreshAuthentication("remote", old),
      manager.refreshAuthentication("remote", old),
    ]);
    expect(new Set(refreshed).size).toBe(1);
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(old.dispose).toHaveBeenCalledTimes(1);
    expect(await manager.refreshAuthentication("remote", old)).toBe(refreshed[0]);
    expect(h.create).toHaveBeenCalledTimes(2);
  });

  it("waits for a short command on the old executor before disposing it", async () => {
    const old = await manager.acquire("remote");
    let finish!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const pending = manager.withExecutor("remote", async () => {
      started();
      await new Promise<void>((resolve) => { finish = resolve; });
    });
    await ready;
    await manager.refreshAuthentication("remote", old);
    expect(old.dispose).not.toHaveBeenCalled();
    finish();
    await pending;
    expect(old.dispose).toHaveBeenCalledTimes(1);
  });

  it("updates all local borrowers without interrupting a retained host connection", async () => {
    const old = await manager.acquire("local-a");
    expect(await manager.acquire("local-b")).toBe(old);
    manager.retain("local-b");
    const fresh = await manager.refreshAuthentication("local-a", old);
    expect(await manager.acquire("local-b")).toBe(fresh);
    expect(await manager.acquireHostChannel()).toBe(fresh);
    expect(old.dispose).not.toHaveBeenCalled();
    manager.release("local-b");
    expect(old.dispose).toHaveBeenCalledTimes(1);
    expect(h.createHost).toHaveBeenCalledTimes(2);
  });

  it("keeps the old connection if replacement configuration cannot be loaded", async () => {
    const old = await manager.acquire("remote");
    h.create.mockImplementationOnce(() => { throw new Error("invalid credentials"); });
    await expect(manager.refreshAuthentication("remote", old)).rejects.toThrow("invalid credentials");
    expect(await manager.acquire("remote")).toBe(old);
    expect(old.dispose).not.toHaveBeenCalled();
  });

  it("disposes a replacement that finishes loading after shutdown", async () => {
    const old = await manager.acquire("remote");
    let loaded!: (value: ReturnType<typeof row>) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    h.get.mockImplementationOnce(() => {
      started();
      return new Promise((resolve) => { loaded = resolve; });
    });
    const refresh = manager.refreshAuthentication("remote", old);
    await ready;
    await manager.destroy();
    loaded(row("remote"));
    await expect(refresh).rejects.toThrow("destroyed");
    const replacement = h.create.mock.results[1]!.value as CommandExecutor;
    expect(old.dispose).toHaveBeenCalledTimes(1);
    expect(replacement.dispose).toHaveBeenCalledTimes(1);
  });

  it("does not dispose the shared bare local executor when no new login exists", async () => {
    const local = executor();
    h.createHost.mockReturnValue(local);
    await manager.acquire("local-a");
    expect(await manager.refreshAuthentication("local-a", local)).toBe(local);
    expect(local.dispose).not.toHaveBeenCalled();
  });

  it("invalidates both the current and retired remote login on a settings change", async () => {
    const old = await manager.acquire("remote");
    manager.retain("remote");
    const fresh = await manager.refreshAuthentication("remote", old);
    manager.invalidate("remote");
    expect(old.dispose).toHaveBeenCalledTimes(1);
    expect(fresh.dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes each host generation once during shutdown, including borrowed markers", async () => {
    const old = await manager.acquire("local-a");
    await manager.acquire("local-b");
    manager.retain("local-b");
    const fresh = await manager.refreshAuthentication("local-a", old);
    await manager.destroy();
    expect(old.dispose).toHaveBeenCalledTimes(1);
    expect(fresh.dispose).toHaveBeenCalledTimes(1);
  });
});
