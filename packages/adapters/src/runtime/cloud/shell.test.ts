import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime, TerminalSession } from "oblien";
import type { ManagedCommandRef } from "@repo/core";
import { openCloudShell } from "./shell";
import { recoverManagedCommand } from "./command-recovery";
import { withManagedCommandTracking } from "./command-tracking";

const terminals = new Map<string, TerminalSession>();
const pending = new Map<string, ManagedCommandRef>();
const hooks = {
  record: vi.fn(async (ref: ManagedCommandRef) => { pending.set(ref.marker, { ...ref }); }),
  complete: vi.fn(async (marker: string) => { pending.delete(marker); }),
};
let onOpen: () => void;
const socket = {
  onOpen: vi.fn((fn: () => void) => { onOpen = fn; }),
  onTerminalOutput: vi.fn(), onTerminalExit: vi.fn(), onClose: vi.fn(), onError: vi.fn(),
  connect: vi.fn(() => queueMicrotask(() => onOpen())), close: vi.fn(),
  writeTerminalInput: vi.fn(), resizeTerminal: vi.fn(),
};
const terminal = { create: vi.fn(), list: vi.fn(), close: vi.fn() };
const exec = { run: vi.fn(), kill: vi.fn() };
const runtime = { terminal, exec, ws: () => socket } as unknown as Runtime;
const open = () => withManagedCommandTracking(hooks, () => openCloudShell(runtime, {}, "owned-vm"));

beforeEach(() => {
  vi.clearAllMocks(); terminals.clear(); pending.clear();
  terminal.create.mockImplementation(async (options: { cmd: string[]; cols: number; rows: number }) => {
    const intent = pending.get(options.cmd.at(-1)!);
    expect(intent).toMatchObject({ workspaceId: "owned-vm", kind: "terminal" });
    expect(intent?.terminalId).toBeUndefined();
    const session = { id: "pty-1", command: options.cmd, cols: options.cols, rows: options.rows, alive: true };
    terminals.set(session.id, session);
    return session;
  });
  terminal.list.mockImplementation(async () => [...terminals.values()]);
  terminal.close.mockImplementation(async (id: string) => { terminals.delete(id); return { success: true }; });
  exec.run.mockImplementation(async (command: string[]) => {
    for (const session of terminals.values()) if (session.command.includes(command.at(-1)!)) session.alive = false;
    return { id: "recovery-task", stdout: `stopped:${command.at(-1)}` };
  });
  exec.kill.mockResolvedValue({ success: true });
});

describe("managed terminal recovery", () => {
  it("records intent before opening and clears it only after verified shutdown", async () => {
    const shell = await open();
    const [ref] = [...pending.values()];
    expect(ref).toMatchObject({ terminalId: "pty-1" });
    expect(terminal.create).toHaveBeenCalledWith(expect.objectContaining({ cmd: expect.arrayContaining([ref.marker]) }));
    shell.stdin.write("pwd\n");
    expect(socket.writeTerminalInput).toHaveBeenCalledWith("pty-1", expect.any(Buffer));
    expect(hooks.complete).not.toHaveBeenCalled();
    await shell.close();
    expect(terminal.close).toHaveBeenCalledExactlyOnceWith("pty-1");
    expect(exec.kill).toHaveBeenCalledWith("recovery-task");
    expect(pending.size).toBe(0);
  });

  it("finds its own terminal after a lost creation response without closing another session", async () => {
    const create = terminal.create.getMockImplementation()!;
    terminal.create.mockImplementationOnce(async (...args) => {
      await create(...args);
      throw new Error("creation acknowledgement lost");
    });
    terminals.set("someone-else", { id: "someone-else", command: ["/bin/bash"], cols: 80, rows: 24, alive: true });
    await expect(open()).rejects.toThrow("acknowledgement lost");
    expect(terminal.close).toHaveBeenCalledExactlyOnceWith("pty-1");
    expect(terminals.get("someone-else")?.alive).toBe(true);
    expect(pending.size).toBe(0);
  });

  it("retains the recovery record when process termination cannot be confirmed", async () => {
    const shell = await open();
    exec.run.mockRejectedValueOnce(new Error("provider offline"));
    await expect(shell.close()).rejects.toMatchObject({ code: "CLOUD_COMMAND_EXIT_UNCONFIRMED" });
    expect(hooks.complete).not.toHaveBeenCalled();
    expect(terminal.close).not.toHaveBeenCalled();
    const [ref] = [...pending.values()];
    await recoverManagedCommand(runtime, ref);
    await hooks.complete(ref.marker);
    expect(pending.size).toBe(0);
  });

  it("does not swallow a failed provider terminal close", async () => {
    const shell = await open();
    terminal.close.mockRejectedValueOnce(new Error("terminal close unavailable"));
    await expect(shell.close()).rejects.toThrow("terminal close unavailable");
    expect(pending.size).toBe(1);
    expect(hooks.complete).not.toHaveBeenCalled();
    await recoverManagedCommand(runtime, [...pending.values()][0]!);
    expect(terminals.size).toBe(0);
  });

  it("rejects a reused terminal id belonging to a different command", async () => {
    const shell = await open();
    terminals.get("pty-1")!.command = ["/bin/bash"];
    await expect(shell.close()).rejects.toMatchObject({ code: "CLOUD_SERVER_IDENTITY_MISMATCH" });
    expect(terminal.close).not.toHaveBeenCalled();
    expect(pending.size).toBe(1);
  });
});
