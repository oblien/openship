import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  enabled: true,
  connections: vi.fn(),
  hosts: vi.fn(),
  connection: vi.fn(),
  host: vi.fn(),
}));
vi.mock("@repo/db", () => ({
  repos: { ingress: { pendingConnections: h.connections, due: h.hosts } },
}));
vi.mock("../../native/execution-policy", () => ({ nativeJobsEnabled: () => h.enabled }));
vi.mock("../../lib/background-work", () => ({
  trackBackgroundWork: (work: Promise<void>) => work,
}));
vi.mock("./service", () => ({ reconcileConnection: h.connection, reconcileHostname: h.host }));
beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  h.enabled = true;
  h.connections.mockResolvedValue([]);
  h.hosts.mockResolvedValue([]);
  await import("./lifecycle");
  vi.useFakeTimers();
});
afterEach(async () => {
  await (await import("./lifecycle")).stopIngressController();
  vi.useRealTimers();
});
describe("managed ingress controller lifecycle", () => {
  it("performs only bounded database queue reads while idle and starts once", async () => {
    const l = await import("./lifecycle");
    l.startIngressController();
    l.startIngressController();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.connections).toHaveBeenCalledOnce();
    expect(h.hosts).toHaveBeenCalledOnce();
    expect(h.connection).not.toHaveBeenCalled();
    expect(h.host).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.connections).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.connections).toHaveBeenCalledTimes(2);
  });
  it("does not start when native jobs are disabled", async () => {
    h.enabled = false;
    const l = await import("./lifecycle");
    l.startIngressController();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.connections).not.toHaveBeenCalled();
  });
  it("does not overlap sweeps and waits for active cleanup before shutdown", async () => {
    let finish!: () => void;
    h.connections.mockResolvedValue([{ id: "connection" }]);
    h.connection.mockImplementation(
      () =>
        new Promise<void>((done) => {
          finish = done;
        }),
    );
    const l = await import("./lifecycle");
    l.startIngressController();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.connection).toHaveBeenCalledOnce();
    let stopped = false;
    const stopping = l.stopIngressController().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(stopped).toBe(false);
    finish();
    await stopping;
    expect(stopped).toBe(true);
    expect(h.hosts).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.connections).toHaveBeenCalledOnce();
  });
});
