/**
 * The safety rails on agent exec.
 *
 * The command itself is free-form shell — that is the capability being granted, and
 * sanitizing it would be theatre. What must hold instead:
 *
 *   - Values WE interpolate (cwd) are shell-quoted. The command is the caller's; the
 *     framing around it must never be.
 *   - The timeout is real: it kills the child rather than just abandoning the
 *     promise, or a runaway command keeps a pooled SSH connection forever.
 *   - Output is capped, because the MCP dispatcher reads the whole body into the
 *     agent's context.
 *   - A non-zero exit is DATA, not an exception — an agent needs to see `exit 1` and
 *     the stderr that came with it.
 */

import { describe, it, expect, vi } from "vitest";
import {
  EXEC_OUTPUT_MAX_BYTES,
  EXEC_TIMEOUT_MAX_MS,
  execInContainer,
  execOnHost,
} from "../../src/lib/agent-exec";

type StreamOpts = { signal?: AbortSignal };

/** A host executor whose streamExec emits the given lines then exits with `code`. */
function hostExecutor(lines: string[], code = 0) {
  const calls: string[] = [];
  return {
    calls,
    exec: vi.fn(),
    streamExec: vi.fn(
      async (command: string, onLog: (l: { message: string }) => void, _opts?: StreamOpts) => {
        calls.push(command);
        for (const message of lines) onLog({ message });
        return { code, output: lines.join("\n") };
      },
    ),
  } as never as Parameters<typeof execOnHost>[0] & { calls: string[] };
}

/** A container executor that echoes back the wrapped command it was handed. */
function containerExecutor(reply: (wrapped: string) => string) {
  const calls: string[] = [];
  return {
    calls,
    exec: vi.fn(async (command: string) => {
      calls.push(command);
      return reply(command);
    }),
  } as never as Parameters<typeof execInContainer>[0] & { calls: string[] };
}

describe("host exec", () => {
  it("returns a non-zero exit code as data, not a throw", async () => {
    const ex = hostExecutor(["boom"], 1);
    const r = await execOnHost(ex, { command: "false" });
    expect(r.exitCode).toBe(1);
    expect(r.output).toBe("boom\n");
    expect(r.timedOut).toBe(false);
  });

  it("shell-quotes cwd — a path with a semicolon stays a path", async () => {
    const ex = hostExecutor([]);
    await execOnHost(ex, { command: "ls", cwd: "/tmp/a b; rm -rf /" });
    const sent = (ex as unknown as { calls: string[] }).calls[0]!;
    // The dangerous text must be inside quotes, so `cd` receives one argument.
    expect(sent).toMatch(/^cd '\/tmp\/a b; rm -rf \/' && ls$/);
  });

  it("passes the command through verbatim — pipes and && are the feature", async () => {
    const ex = hostExecutor([]);
    await execOnHost(ex, { command: "ps aux | grep node && echo ok" });
    expect((ex as unknown as { calls: string[] }).calls[0]).toBe("ps aux | grep node && echo ok");
  });

  it("stops accumulating at the cap and reports truncation", async () => {
    const small = hostExecutor(["x".repeat(50), "y".repeat(50)]);
    const r = await execOnHost(small, { command: "cat small", maxOutputBytes: 4096 });
    expect(r.truncated).toBe(false);
    expect(r.output.length).toBe(102);

    // 30 × 51 = 1530 bytes against a 1 KiB cap.
    const big = hostExecutor(Array.from({ length: 30 }, () => "z".repeat(50)));
    const capped = await execOnHost(big, { command: "cat big", maxOutputBytes: 1024 });
    expect(capped.truncated).toBe(true);
    expect(capped.output.length).toBeLessThanOrEqual(1024);
  });

  it("floors the cap at 1 KiB — a byte-sized cap is a mistake, not a request", async () => {
    // 10 × 51 = 510 bytes. Asking for 60 clamps UP to 1024, so nothing truncates.
    const ex = hostExecutor(Array.from({ length: 10 }, () => "q".repeat(50)));
    const r = await execOnHost(ex, { command: "cat mid", maxOutputBytes: 60 });
    expect(r.truncated).toBe(false);
    expect(r.output.length).toBe(510);
  });

  it("clamps an over-large timeout to the ceiling rather than honouring it", async () => {
    let seen: AbortSignal | undefined;
    const ex = {
      exec: vi.fn(),
      streamExec: vi.fn(async (_c: string, _l: unknown, opts?: StreamOpts) => {
        seen = opts?.signal;
        return { code: 0, output: "" };
      }),
    } as never as Parameters<typeof execOnHost>[0];
    await execOnHost(ex, { command: "sleep 1", timeoutMs: EXEC_TIMEOUT_MAX_MS * 100 });
    // An AbortSignal is always supplied — that is what makes the timeout killable.
    expect(seen).toBeInstanceOf(AbortSignal);
  });

  it("reports timedOut when the abort fires, and keeps the partial output", async () => {
    const ex = {
      exec: vi.fn(),
      streamExec: vi.fn(async (_c: string, onLog: (l: { message: string }) => void, opts?: StreamOpts) => {
        onLog({ message: "partial" });
        // Mimic a real executor: reject once the signal aborts.
        await new Promise((_res, rej) => {
          opts?.signal?.addEventListener("abort", () => rej(new Error("aborted")));
        });
        return { code: 0, output: "" };
      }),
    } as never as Parameters<typeof execOnHost>[0];

    const r = await execOnHost(ex, { command: "sleep 999", timeoutMs: 1000 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(-1);
    expect(r.output).toBe("partial\n");
  });

  it("re-throws a real transport error instead of reporting a fake timeout", async () => {
    const ex = {
      exec: vi.fn(),
      streamExec: vi.fn(async () => {
        throw new Error("ssh: connection refused");
      }),
    } as never as Parameters<typeof execOnHost>[0];
    await expect(execOnHost(ex, { command: "ls" })).rejects.toThrow(/connection refused/);
  });

  it("defaults the cap to the module ceiling", async () => {
    const ex = hostExecutor(["a".repeat(EXEC_OUTPUT_MAX_BYTES + 10)]);
    const r = await execOnHost(ex, { command: "cat huge" });
    expect(r.truncated).toBe(true);
  });
});

describe("container exec", () => {
  it("merges stderr and recovers the real exit code from the sentinel", async () => {
    // The wrapper always exits 0, so the code has to come back in-band.
    const ex = containerExecutor((wrapped) => {
      expect(wrapped.startsWith("exec 2>&1; ")).toBe(true);
      return "line one\nline two\n__openship_exec_exit__:3";
    });
    const r = await execInContainer(ex, { command: "sh -c 'echo hi; exit 3'" });
    expect(r.exitCode).toBe(3);
    expect(r.output).toBe("line one\nline two");
  });

  it("uses the LAST sentinel, so output that mimics one cannot spoof the code", async () => {
    const ex = containerExecutor(
      () => "__openship_exec_exit__:0 <- printed by the command\n__openship_exec_exit__:7",
    );
    const r = await execInContainer(ex, { command: "cat spoof" });
    expect(r.exitCode).toBe(7);
    expect(r.output).toContain("printed by the command");
  });

  it("treats a missing sentinel as success rather than crashing", async () => {
    const ex = containerExecutor(() => "no sentinel here");
    const r = await execInContainer(ex, { command: "echo hi" });
    expect(r.exitCode).toBe(0);
    expect(r.output).toBe("no sentinel here");
  });

  it("shell-quotes cwd inside the wrapper too", async () => {
    const ex = containerExecutor(() => "__openship_exec_exit__:0");
    await execInContainer(ex, { command: "ls", cwd: "/app; whoami" });
    expect((ex as unknown as { calls: string[] }).calls[0]).toContain("cd '/app; whoami' && ls");
  });

  it("uses `exec 2>&1` rather than PIPESTATUS — these containers are often Alpine", async () => {
    const ex = containerExecutor(() => "__openship_exec_exit__:0");
    await execInContainer(ex, { command: "ls" });
    const sent = (ex as unknown as { calls: string[] }).calls[0]!;
    expect(sent).toContain("exec 2>&1");
    expect(sent).not.toContain("PIPESTATUS");
  });

  it("truncates oversized output and flags it", async () => {
    const ex = containerExecutor(() => `${"z".repeat(5000)}\n__openship_exec_exit__:0`);
    const r = await execInContainer(ex, { command: "cat big", maxOutputBytes: 1024 });
    expect(r.truncated).toBe(true);
    expect(r.output.length).toBe(1024);
  });

  it("maps a transport timeout to timedOut, and re-throws anything else", async () => {
    const timeout = { exec: vi.fn(async () => { throw new Error("command timed out"); }) } as never as Parameters<typeof execInContainer>[0];
    const r = await execInContainer(timeout, { command: "sleep 999" });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(-1);

    const gone = { exec: vi.fn(async () => { throw new Error("No such container"); }) } as never as Parameters<typeof execInContainer>[0];
    await expect(execInContainer(gone, { command: "ls" })).rejects.toThrow(/No such container/);
  });
});
