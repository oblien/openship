import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandSourceBackupExecutor } from "./command-source";
import type { CommandExecutor } from "../../types";
import type { ServiceHandle } from "../types";

afterEach(() => vi.useRealTimers());

describe("provider export channel admission", () => {
  it.each(["cancel", "timeout"])("closes a late source channel after %s", async (reason) => {
    vi.useFakeTimers();
    let opened!: (value: unknown) => void;
    const rawExec = vi.fn(
      () =>
        new Promise((resolve) => {
          opened = resolve;
        }),
    );
    const signal = new AbortController();
    const source = new CommandSourceBackupExecutor({ rawExec } as unknown as CommandExecutor, []);
    const opening = source.execStream({} as ServiceHandle, ["redis-cli", "INFO"], {
      signal: signal.signal,
    });
    const rejected = expect(opening).rejects.toThrow(
      reason === "timeout" ? /within 30 seconds/ : /abort/i,
    );
    if (reason === "cancel") signal.abort();
    else await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    const child = {
      stdout: Readable.from([]),
      stderr: Readable.from([]),
      onClose: Promise.resolve(0),
      kill: vi.fn(),
    };
    opened(child);
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledOnce();
    child.stdout.destroy();
    child.stderr.destroy();
  });
});
