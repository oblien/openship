import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "oblien";
import { withManagedCommandTracking } from "./command-tracking";
import type { ManagedCommandRef } from "@repo/core";
import { CloudWorkspaceExecutor } from "./workspace-executor";

let executor: CloudWorkspaceExecutor;
let stream: ReturnType<typeof vi.fn>;
let kill: ReturnType<typeof vi.fn>;
let cancelProcesses: ReturnType<typeof vi.fn>;
let files: { write: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
beforeEach(() => {
  stream = vi.fn(); kill = vi.fn().mockResolvedValue({ success: true });
  cancelProcesses = vi.fn(async (command: string[]) => ({ stdout: `stopped:${command.at(-1)}` }));
  files = { write: vi.fn().mockResolvedValue({ success: true }), delete: vi.fn().mockResolvedValue({ success: true }) };
  executor = new CloudWorkspaceExecutor(async () => ({ exec: { stream, kill, run: cancelProcesses }, files }) as unknown as Runtime, "test-vm");
});
afterEach(async () => { await executor.dispose(); vi.restoreAllMocks(); });

function frame(command: string[], channel: "o" | "e" | "x", value: Buffer | string | number): Buffer {
  const marker = command.at(-1)!.match(/openship-exec-[a-f0-9-]+:/)![0];
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return Buffer.concat([Buffer.from(`\x1e${marker}${channel}:${bytes.length}\x1f`), bytes]);
}
function exitFrame(command: string[], code: number): Buffer {
  return frame(command, "x", code);
}

describe("workspace command transport", () => {
  it("releases completed commands so a long app install does not exhaust retained task slots", async () => {
    const retained = new Set(["another-command"]);
    let sequence = 0;
    stream.mockImplementation(async function* (command: string[]) {
      if (retained.size >= 50) throw new Error("max tasks reached (50)");
      const id = `owned-${++sequence}`;
      retained.add(id);
      yield { event: "task_id", task_id: id };
      yield { event: "stdout", data: exitFrame(command, 0).toString("base64") };
      yield { event: "exit", exit_code: 0 };
    });
    kill.mockImplementation(async (id) => {
      retained.delete(id);
      return { success: true };
    });
    for (let i = 0; i < 60; i++) await executor.exec("prepare app configuration");
    expect(retained).toEqual(new Set(["another-command"]));
  });
  it("streams binary stdout and distinct stderr and finishes on the exit event", async () => {
    const bytes = Buffer.from([0, 1, 255, 10, 13]);
    stream.mockImplementation(async function* (command: string[]) {
      yield { event: "task_id", task_id: "owned-task" };
      yield { event: "stdout", data: frame(command, "o", bytes).toString("base64") };
      // The provider PTY merges both channels; the adapter must separate them.
      yield { event: "stdout", data: frame(command, "e", "diagnostic").toString("base64") };
      const marker = exitFrame(command, 0);
      for (const piece of [marker.subarray(0, 3), marker.subarray(3, 21), marker.subarray(21)]) {
        yield { event: "stdout", data: piece.toString("base64") };
      }
      yield { event: "exit", exit_code: 1 }; // the PTY close status is not the command's status
      throw new Error("must not wait for the SSE connection to close");
    });
    const child = await executor.rawExec("emit binary");
    const out: Buffer[] = [], err: Buffer[] = [];
    child.stdout.on("data", b => out.push(b)); child.stderr.on("data", b => err.push(b));
    expect(await child.onClose).toBe(0);
    expect(Buffer.concat(out)).toEqual(bytes);
    expect(Buffer.concat(err).toString()).toBe("diagnostic");
    expect(stream).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ execMode: "direct", keepLogs: false }));
    expect(kill).toHaveBeenCalledExactlyOnceWith("owned-task");
    expect(cancelProcesses).not.toHaveBeenCalled();
  });
  it("rejects a disconnected command and kills only its own provider task", async () => {
    stream.mockImplementation(async function* () {
      yield { event: "task_id", task_id: "owned-task" };
      throw new Error("provider stream interrupted");
    });
    const child = await executor.rawExec("long build");
    await expect(child.onClose).rejects.toThrow("provider stream interrupted");
    expect(kill).toHaveBeenCalledExactlyOnceWith("owned-task");
    expect(cancelProcesses).toHaveBeenCalledOnce();
  });
  it("waits for verified cancellation and removes a task whose ID arrives afterwards", async () => {
    let release!: () => void;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    stream.mockImplementation(async function* () {
      await delayed;
      yield { event: "task_id", task_id: "late-task" };
      yield { event: "exit", exit_code: 137 };
    });
    let acknowledge!: () => void;
    const stopped = new Promise<void>(resolve => { acknowledge = resolve; });
    cancelProcesses.mockImplementation(async (command: string[]) => {
      await stopped;
      return { stdout: `stopped:${command.at(-1)}` };
    });
    const child = await executor.rawExec("long build");
    let settled = false;
    void child.onClose.finally(() => { settled = true; }).catch(() => {});
    child.kill();
    await vi.waitFor(() => expect(cancelProcesses).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    acknowledge();
    await expect(child.onClose).rejects.toThrow("cancelled");
    release();
    await vi.waitFor(() => expect(kill).toHaveBeenCalledExactlyOnceWith("late-task"));
  });
  it("persists command intent before dispatch and retains it when exit cannot be confirmed", async () => {
    const pending = new Map<string, ManagedCommandRef>();
    const hooks = { record: async (command: ManagedCommandRef) => { pending.set(command.marker, command); },
      complete: async (marker: string) => { pending.delete(marker); } };
    stream.mockImplementation(async function* () {
      expect(pending.size).toBe(1);
      yield { event: "task_id", task_id: "retained-task" };
      throw new Error("connection lost");
    });
    cancelProcesses.mockRejectedValueOnce(new Error("server unreachable"));
    await expect(withManagedCommandTracking(hooks, () => executor.exec("long build")))
      .rejects.toMatchObject({ code: "CLOUD_COMMAND_EXIT_UNCONFIRMED" });
    const [command] = [...pending.values()];
    expect(command).toMatchObject({ workspaceId: "test-vm", taskId: "retained-task" });
    expect(kill).not.toHaveBeenCalled();
    expect(files.delete).not.toHaveBeenCalled();
    await executor.recoverCommand(command);
    await hooks.complete(command.marker);
    expect(pending.size).toBe(0);
    expect(kill).toHaveBeenCalledExactlyOnceWith("retained-task");
  });
  it("cancels a potentially created command even when the creation reply was lost", async () => {
    stream.mockImplementation(async function* () { throw new Error("creation reply lost"); });
    await expect(executor.exec("delayed request")).rejects.toThrow("creation reply lost");
    expect(cancelProcesses).toHaveBeenCalledOnce();
    expect(files.delete).not.toHaveBeenCalled();
  });
  it("refuses a recovered command for another workspace before sending anything", async () => {
    await expect(executor.recoverCommand({ workspaceId: "other-vm", marker: "unused" })).rejects.toThrow("another server");
    expect(cancelProcesses).not.toHaveBeenCalled();
  });
  it("preserves command failure status and streams logs before rejecting exec", async () => {
    stream.mockImplementation(async function* (command: string[]) {
      yield { event: "stdout", data: frame(command, "e", "build failed").toString("base64") };
      yield { event: "stdout", data: exitFrame(command, 7).toString("base64") };
      yield { event: "exit", exit_code: 0 };
    });
    expect((await executor.streamExec("failed build", () => {})).code).toBe(7);
    await expect(executor.exec("failed build")).rejects.toThrow("build failed");
  });
  it("rejects an incomplete success response instead of claiming the command finished", async () => {
    stream.mockImplementation(async function* () { yield { event: "exit", exit_code: 0 }; });
    await expect(executor.exec("unfinished command")).rejects.toThrow("verified exit status");
  });
  it.each(["unframed", "incomplete", "oversize", "after-exit"])("rejects a %s command stream", async kind => {
    stream.mockImplementation(async function* (command: string[]) {
      const data = kind === "unframed" ? Buffer.from("provider diagnostic, not an archive")
        : kind === "incomplete" ? frame(command, "o", "archive").subarray(0, -1)
        : kind === "oversize" ? frame(command, "o", Buffer.alloc(32769))
        : Buffer.concat([exitFrame(command, 0), frame(command, "o", "trailing")]);
      yield { event: "stdout", data: data.toString("base64") };
      yield { event: "exit", exit_code: 0 };
    });
    await expect(executor.exec("capture backup")).rejects.toThrow(/fram/i);
  });
  it("preserves every byte across split headers and payloads", async () => {
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    stream.mockImplementation(async function* (command: string[]) {
      const data = Buffer.concat([frame(command, "o", bytes), frame(command, "e", bytes), exitFrame(command, 0)]);
      for (let i = 0; i < data.length; i += 3)
        yield { event: "stdout", data: data.subarray(i, i + 3).toString("base64") };
      yield { event: "exit", exit_code: 0 };
    });
    const child = await executor.rawExec("binary archive");
    const out: Buffer[] = [], err: Buffer[] = [];
    child.stdout.on("data", b => out.push(b)); child.stderr.on("data", b => err.push(b));
    expect(await child.onClose).toBe(0);
    expect(Buffer.concat(out)).toEqual(bytes);
    expect(Buffer.concat(err)).toEqual(bytes);
  });
  it("preserves UTF-8 text when characters span command frames", async () => {
    const stdout = "Ready 世界 🙂\n", stderr = "تنبيه\n";
    stream.mockImplementation(async function* (command: string[]) {
      for (const [channel, value] of [["o", stdout], ["e", stderr]] as const) {
        const bytes = Buffer.from(value);
        for (let offset = 0; offset < bytes.length; offset += 2)
          yield { event: "stdout", data: frame(command, channel, bytes.subarray(offset, offset + 2)).toString("base64") };
      }
      yield { event: "stdout", data: exitFrame(command, 0).toString("base64") };
      yield { event: "exit", exit_code: 0 };
    });
    const logs: Array<{ message: string; level: string; rawData?: string }> = [];
    expect(await executor.streamExec("localized output", entry => logs.push(entry))).toEqual({ code: 0, output: stdout + stderr });
    for (const [level, expected] of [["info", stdout], ["error", stderr]]) {
      const channel = logs.filter(entry => entry.level === level);
      expect(channel.map(entry => entry.message).join("")).toBe(expected);
      expect(Buffer.concat(channel.map(entry => Buffer.from(entry.rawData!, "base64"))).toString()).toBe(expected);
    }
  });
  it("applies backpressure without buffering an entire backup", async () => {
    const chunk = Buffer.alloc(32768, 0xff);
    let read = 0;
    stream.mockImplementation(async function* (command: string[]) {
      for (let i = 0; i < 100; i++) {
        read++;
        yield { event: "stdout", data: frame(command, "o", chunk).toString("base64") };
      }
      yield { event: "stdout", data: exitFrame(command, 0).toString("base64") };
      yield { event: "exit", exit_code: 0 };
    });
    const child = await executor.rawExec("large backup");
    await vi.waitFor(() => expect(read).toBeGreaterThan(1));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(read).toBeLessThan(100);
    let bytes = 0;
    child.stdout.on("data", chunk => { bytes += chunk.length; });
    expect(await child.onClose).toBe(0);
    expect(bytes).toBe(100 * chunk.length);
  });
  it("replaces a file only after the provider confirms its write", async () => {
    const commands = vi.spyOn(executor, "exec").mockResolvedValue("");
    await executor.writeFile("/private/config", "secret", { mode: 0o600 });
    expect(commands.mock.calls[0]![0]).toContain("umask 077");
    expect(commands.mock.calls[1]![0]).toMatch(/^mv -- .*openship-.* '\/private\/config'$/);
    files.write.mockResolvedValue({ success: false });
    commands.mockClear();
    await expect(executor.writeFile("/private/config", "new value")).rejects.toThrow("Could not write");
    expect(commands).toHaveBeenCalledTimes(1);
    expect(files.delete).toHaveBeenCalledOnce();
  });
});
