import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkloadInfo } from "oblien";
import { CloudProcessSupervisor } from "./process-supervisor";
import type { CloudServerConnection } from "./server-connection";

vi.mock("../port-conflict", () => ({ probeListeningPortState: vi.fn(async () => ({ checked: true, occupant: null })) }));
let supervisor: CloudProcessSupervisor;
let rows: Map<string, WorkloadInfo>;
let live: Map<string, string>;
let workloads: ReturnType<typeof fixture>;
const missing = () => Object.assign(new Error("missing"), { status: 404 });
function fixture() {
  const get = (id: string) => { const row = rows.get(id); if (!row) throw missing(); return structuredClone(row); };
  return {
    list: vi.fn(async () => [...rows.values()].map(row => structuredClone(row))),
    get: vi.fn(async (id: string) => get(id)),
    status: vi.fn(async (id: string) => { if (!live.has(id)) throw missing(); return { success: true, status: { id, state: live.get(id) } }; }),
    create: vi.fn(async (input: WorkloadInfo) => { rows.set(input.id, structuredClone(input)); live.set(input.id, "running"); return get(input.id); }),
    start: vi.fn(async (id: string) => { rows.get(id)!.enabled = true; live.set(id, "running"); return { success: true }; }),
    stop: vi.fn(async (id: string) => { rows.get(id)!.enabled = false; live.set(id, "stopped"); return { success: true }; }),
    delete: vi.fn(async (id: string) => { rows.delete(id); live.delete(id); return { success: true }; }),
    logsStream: vi.fn(),
  };
}
const options = { projectId: "project-a", deploymentId: "release-a", workDir: "/projects/a/releases/release-a", startCommand: "exec node server.js", port: 3000, ports: [3000], env: { KEEP: "value" } };
beforeEach(() => {
  rows = new Map(); live = new Map(); workloads = fixture();
  const connection = {
    state: vi.fn(async () => "running"), resume: vi.fn(), publishedPorts: vi.fn(async () => []),
    workspace: () => ({ workloads }), runExclusive: <T>(work: () => Promise<T>) => work(),
    executor: { mkdir: vi.fn(), exec: vi.fn(async () => options.workDir) },
  } as unknown as CloudServerConnection;
  supervisor = new CloudProcessSupervisor(connection, "project-a", "/projects/a");
});
afterEach(async () => { await supervisor.dispose(); vi.restoreAllMocks(); });

describe("shared bare lifecycle on a managed server", () => {
  it("preserves the requested process identity and reuses an unchanged release", async () => {
    await supervisor.deploy(options);
    await supervisor.deploy(options);
    expect(workloads.create).toHaveBeenCalledOnce();
    expect(rows.get("openship-release-a")).toMatchObject({ enabled: true, labels: { "openship.project": "project-a", "openship.deployment": "release-a" } });
  });
  it("uses live status when saved configuration retains a stale stopped state", async () => {
    await supervisor.deploy(options);
    rows.get("openship-release-a")!.state = "stopped";
    expect(await supervisor.getInfo("release-a")).toMatchObject({ status: "running", hostPortByContainerPort: { 3000: 3000 } });
  });
  it("preserves stopped state across a VM restart with no guest process", async () => {
    await supervisor.deploy(options);
    await supervisor.stop("release-a");
    live.clear();
    expect(await supervisor.getInfo("release-a")).toMatchObject({ status: "stopped" });
    await supervisor.start("release-a");
    expect(await supervisor.isRunning("release-a")).toBe(true);
    expect(rows.get("openship-release-a")!.enabled).toBe(true);
  });
  it("does not accept a successful stop response unless disabled state is persisted", async () => {
    await supervisor.deploy(options);
    workloads.stop.mockImplementation(async id => { live.set(id, "stopped"); return { success: true }; });
    await expect(supervisor.stop("release-a")).rejects.toThrow("did not persist");
  });
  it("can archive an already stopped release without issuing an invalid second stop", async () => {
    await supervisor.deploy(options);
    await supervisor.stop("release-a");
    workloads.stop.mockRejectedValue(Object.assign(new Error("already stopped"), { status: 409, code: "invalid_state" }));
    await supervisor.stop("release-a");
    expect(workloads.stop).toHaveBeenCalledOnce();
    expect(await supervisor.getInfo("release-a")).toMatchObject({ status: "stopped" });
  });
  it("does not trust a saved stopped state while the live process is still running", async () => {
    await supervisor.deploy(options);
    Object.assign(rows.get("openship-release-a")!, { enabled: false, state: "stopped" });
    await supervisor.stop("release-a");
    expect(workloads.stop).toHaveBeenCalledOnce();
    expect(live.get("openship-release-a")).toBe("stopped");
  });
  it.each([false, true])("confirms both disabled and stopped state after a conflicting stop (disabled=%s)", async disabled => {
    await supervisor.deploy(options);
    workloads.stop.mockImplementation(async id => {
      live.set(id, "stopped");
      rows.get(id)!.enabled = !disabled;
      throw Object.assign(new Error("already stopped"), { status: 409, code: "invalid_state" });
    });
    const stop = supervisor.stop("release-a");
    if (disabled) await expect(stop).resolves.toBeUndefined();
    else await expect(stop).rejects.toMatchObject({ code: "invalid_state" });
  });
  it("rejects foreign ownership before changing or deleting a process", async () => {
    await supervisor.deploy(options);
    rows.get("openship-release-a")!.labels = { "openship.project": "project-b", "openship.deployment": "release-a" };
    for (const action of ["start", "stop", "destroy"] as const)
      await expect(supervisor[action]("release-a")).rejects.toMatchObject({ code: "PROCESS_NOT_FOUND" });
    expect(workloads.start).not.toHaveBeenCalled();
    expect(workloads.stop).not.toHaveBeenCalled();
    expect(workloads.delete).not.toHaveBeenCalled();
  });
  it("rejects a status for a different identity instead of reporting it as running", async () => {
    await supervisor.deploy(options);
    workloads.status.mockResolvedValue({ success: true, status: { id: "another-process", state: "running" } });
    await expect(supervisor.getInfo("release-a")).rejects.toMatchObject({ code: "PROCESS_STATUS_UNAVAILABLE" });
  });
  it("removes only the selected process and confirms its disappearance", async () => {
    await supervisor.deploy(options);
    const other = { ...rows.get("openship-release-a")!, id: "foreign", labels: { "openship.project": "project-b" } };
    rows.set("foreign", other);
    await supervisor.destroy("release-a");
    expect(workloads.delete).toHaveBeenCalledExactlyOnceWith("openship-release-a");
    expect(rows.get("foreign")).toEqual(other);
  });
  it("preserves log failure and does not read the whole VM's logs as fallback", async () => {
    await supervisor.deploy(options);
    workloads.logsStream.mockImplementation(async function* () { throw new Error("application log stream unavailable"); });
    const onEnd = vi.fn();
    await supervisor.streamLogs("release-a", vi.fn(), { tail: 0, onEnd });
    await vi.waitFor(() => expect(onEnd).toHaveBeenCalledWith(expect.objectContaining({ message: "application log stream unavailable" })));
  });
  it("cancels an application log stream without publishing a disconnect error", async () => {
    await supervisor.deploy(options);
    let observed: AbortSignal | undefined;
    workloads.logsStream.mockImplementation(async function* (_id, options: { signal: AbortSignal }) {
      observed = options.signal;
      yield { line: "ready", stream: "stdout" };
      if (!options.signal.aborted) await new Promise<void>(resolve => options.signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    const onEnd = vi.fn(), onLog = vi.fn();
    const stop = await supervisor.streamLogs("release-a", onLog, { tail: 0, onEnd });
    await vi.waitFor(() => expect(onLog).toHaveBeenCalled());
    stop();
    expect(observed?.aborted).toBe(true);
    expect(onEnd).not.toHaveBeenCalled();
  });
});
