import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";

/**
 * `streamExec`'s signal is how a cancelled deploy stops a remote `docker build`.
 * SshExecutor (ssh2) honours it; this executor — the one used for agent-auth
 * servers, where the OS `ssh` binary does the authenticating — used to drop the
 * option on the floor, so a cancel there let the build run to completion and the
 * deployment came back "deploying". These tests pin the kill and the exit code.
 */

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: vi.fn(), end: vi.fn() };
  kill = vi.fn((_signal?: string) => {
    // Real ssh dies and the close event carries no exit code.
    this.emit("close", null);
    return true;
  });
}

const spawned: FakeChild[] = [];
vi.mock("node:child_process", () => ({
  // ensureMaster()'s `-fN` handshake, promisified at module load.
  execFile: (
    ..._args: [string, string[], object, (err: Error | null, stdout: string, stderr: string) => void]
  ) => {
    const cb = _args[_args.length - 1] as (
      err: Error | null,
      stdout: string,
      stderr: string,
    ) => void;
    cb(null, "", "");
  },
  spawn: () => {
    const child = new FakeChild();
    spawned.push(child);
    return child;
  },
}));

import { SystemSshExecutor } from "./system-ssh-executor";

const CONFIG = { host: "h", username: "u", useSystemSsh: true };

describe("SystemSshExecutor.streamExec abort", () => {
  it("kills the ssh child and resolves with code 0 when the signal fires", async () => {
    const executor = new SystemSshExecutor(CONFIG);
    const controller = new AbortController();

    const promise = executor.streamExec("docker build .", () => {}, {
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      if (spawned.length === 0) throw new Error("not spawned yet");
    });

    controller.abort();

    // code 0, not the killed child's null→1: an abort is the caller's own
    // decision, so it must not read as a transport failure (matches SshExecutor).
    await expect(promise).resolves.toEqual({ code: 0, output: "" });
    expect(spawned.at(-1)!.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("binds ordinary exec to the ambient deployment signal and waits for child close", async () => {
    const executor = new SystemSshExecutor(CONFIG);
    const controller = new AbortController();
    const before = spawned.length;
    const pending = executor.runWithAbortSignal(controller.signal, () => executor.exec("sleep 999"));
    await vi.waitFor(() => {
      if (spawned.length === before) throw new Error("not spawned yet");
    });

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(spawned.at(-1)!.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("never spawns when the signal is already aborted", async () => {
    const executor = new SystemSshExecutor(CONFIG);
    const before = spawned.length;

    await expect(
      executor.streamExec("docker build .", () => {}, { signal: AbortSignal.abort() }),
    ).resolves.toEqual({ code: 0, output: "" });
    expect(spawned.length).toBe(before);
  });
});
