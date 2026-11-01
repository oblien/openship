import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ forward: vi.fn(), retain: vi.fn(), release: vi.fn(), close: vi.fn() }));
vi.mock("@repo/db", () => ({ repos: {}, withAdvisoryLock: vi.fn() }));
vi.mock("../src/engine/lib/ssh-tunnel", () => ({ tunnelForward: h.forward }));
vi.mock("../src/engine/lib/ssh-manager", () => ({ sshManager: { retain: h.retain, release: h.release } }));
vi.mock("../src/engine/lib/startup/index", () => ({ registerStartupHook: vi.fn() }));
import { getTunnelStatus, startTunnel, stopTunnel, stopAllTunnels } from "../src/engine/lib/ssh-tunnel-manager";

const args = { tunnelId: "tunnel", serverId: "server", remotePort: 5432 };
const handle = () => ({ localPort: 49100, remoteHost: "127.0.0.1", remotePort: 5432, activeConnections: 0, close: h.close });
beforeEach(() => {
  vi.clearAllMocks();
  h.close.mockResolvedValue(undefined);
  h.forward.mockResolvedValue(handle());
});
afterEach(async () => { await stopAllTunnels(); vi.useRealTimers(); });

describe("owned tunnel lifecycle", () => {
  it("opens only one listener and holds SSH once under simultaneous starts", async () => {
    const statuses = await Promise.all([startTunnel(args), startTunnel(args), startTunnel(args)]);
    expect(statuses[0]).toEqual(statuses[1]);
    expect(h.forward).toHaveBeenCalledTimes(1);
    expect(h.retain).toHaveBeenCalledTimes(1);
    await Promise.all([stopTunnel(args.tunnelId), stopTunnel(args.tunnelId)]);
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("waits for a pending start before stopping its listener", async () => {
    let finish!: (value: ReturnType<typeof handle>) => void;
    h.forward.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const starting = startTunnel(args);
    await vi.waitFor(() => expect(h.forward).toHaveBeenCalledTimes(1));
    const stopping = stopTunnel(args.tunnelId);
    expect(h.close).not.toHaveBeenCalled();
    finish(handle());
    await starting;
    await stopping;
    expect(getTunnelStatus(args.tunnelId)).toBeNull();
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("drains pending starts at shutdown and refuses new starts while closing", async () => {
    let finish!: (value: ReturnType<typeof handle>) => void;
    h.forward.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const starting = startTunnel(args);
    await vi.waitFor(() => expect(h.forward).toHaveBeenCalledTimes(1));
    const closing = stopAllTunnels();
    await expect(startTunnel({ ...args, tunnelId: "later" })).rejects.toMatchObject({ code: "PLATFORM_CLOSING" });
    finish(handle());
    await starting;
    await closing;
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(getTunnelStatus(args.tunnelId)).toBeNull();
  });

  it("releases a failed listener's SSH hold and permits a later retry", async () => {
    h.forward.mockRejectedValueOnce(new Error("bind failed"));
    await expect(startTunnel(args)).rejects.toThrow("bind failed");
    expect(getTunnelStatus(args.tunnelId)).toBeNull();
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(await startTunnel(args)).toMatchObject({ localPort: 49100 });
    await stopTunnel(args.tunnelId);
    expect(h.release).toHaveBeenCalledTimes(2);
  });

  it("revalidates live authority and closes the listener after revocation", async () => {
    vi.useFakeTimers();
    let allowed = true;
    const assertAccess = vi.fn(async () => { if (!allowed) throw new Error("access revoked"); });
    await startTunnel({ ...args, assertAccess });
    await h.forward.mock.calls[0]![2].beforeConnect();
    expect(assertAccess).toHaveBeenCalledTimes(2);
    allowed = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(getTunnelStatus(args.tunnelId)).toBeNull();
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("checks authority before obtaining a host resource", async () => {
    await expect(startTunnel({ ...args, assertAccess: async () => { throw new Error("denied"); } })).rejects.toThrow("denied");
    expect(h.retain).not.toHaveBeenCalled();
    expect(h.forward).not.toHaveBeenCalled();
  });

  it.each(["timer", "socket"])("drains an in-flight %s authorization check before releasing storage", async source => {
    vi.useFakeTimers();
    let finish!: () => void;
    const assertAccess = vi.fn(async () => {});
    await startTunnel({ ...args, assertAccess });
    assertAccess.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    if (source === "timer") await vi.advanceTimersByTimeAsync(1000);
    else void h.forward.mock.calls[0]![2].beforeConnect();
    await Promise.resolve();
    let closed = false;
    const closing = stopAllTunnels().then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.close).toHaveBeenCalledOnce();
    expect(closed).toBe(false);
    finish();
    await closing;
    expect(closed).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(assertAccess).toHaveBeenCalledTimes(2);
  });
});
