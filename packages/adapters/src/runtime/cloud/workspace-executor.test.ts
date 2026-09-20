import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "oblien";
import { CloudWorkspaceExecutor } from "./workspace-executor";

let executor: CloudWorkspaceExecutor;
let stream: ReturnType<typeof vi.fn>;
let kill: ReturnType<typeof vi.fn>;
let files: { write: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
beforeEach(() => {
  stream = vi.fn(); kill = vi.fn().mockResolvedValue(undefined);
  files = { write: vi.fn().mockResolvedValue({ success: true }), delete: vi.fn().mockResolvedValue({ success: true }) };
  executor = new CloudWorkspaceExecutor(async () => ({ exec: { stream, kill }, files }) as unknown as Runtime);
});
afterEach(async () => { await executor.dispose(); vi.restoreAllMocks(); });

function exitFrame(command: string[], code: number): Buffer {
  const marker = command.at(-1)!.match(/openship-exit-[a-f0-9-]+:/)![0];
  return Buffer.from(`\x1e${marker}${code}\x1f`);
}

describe("workspace command transport", () => {
  it("streams binary stdout and distinct stderr and finishes on the exit event", async () => {
    const bytes = Buffer.from([0, 1, 255, 10, 13]);
    stream.mockImplementation(async function* (command: string[]) {
      yield { event: "task_id", task_id: "owned-task" };
      yield { event: "stdout", data: bytes.toString("base64") };
      yield { event: "stderr", data: Buffer.from("diagnostic").toString("base64") };
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
    expect(kill).not.toHaveBeenCalled();
  });
  it("rejects a disconnected command and kills only its own provider task", async () => {
    stream.mockImplementation(async function* () {
      yield { event: "task_id", task_id: "owned-task" };
      throw new Error("provider stream interrupted");
    });
    const child = await executor.rawExec("long build");
    await expect(child.onClose).rejects.toThrow("provider stream interrupted");
    expect(kill).toHaveBeenCalledExactlyOnceWith("owned-task");
  });
  it("cancels immediately and still kills a task ID delivered after cancellation", async () => {
    let release!: () => void;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    stream.mockImplementation(async function* () {
      await delayed;
      yield { event: "task_id", task_id: "late-task" };
      yield { event: "exit", exit_code: 137 };
    });
    const controller = new AbortController();
    const child = await executor.runWithAbortSignal(controller.signal, () => executor.rawExec("long build"));
    controller.abort();
    await expect(child.onClose).rejects.toThrow("cancelled");
    expect(kill).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(kill).toHaveBeenCalledExactlyOnceWith("late-task"));
  });
  it("preserves command failure status and streams logs before rejecting exec", async () => {
    stream.mockImplementation(async function* (command: string[]) {
      yield { event: "stderr", data: Buffer.from("build failed").toString("base64") };
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
