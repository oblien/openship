import Dockerode from "dockerode";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { DockerRuntime, buildInContainerExecCmd, splitDockerFrames } from "./docker";

/**
 * Regression cover for the one-shot in-container exec (app prepare steps + the
 * advisory port/static probes).
 *
 * The bug these pin: `exec.start({hijack: true})` makes docker-modem ask for a
 * connection upgrade. The daemon answers `101 Switching Protocols`; under Bun
 * node:http surfaces that as a plain `response`, so modem rejected with
 * `(HTTP code 101) unexpected - <the command's own stdout>` — i.e. every
 * SUCCESSFUL exec was reported as failed, with its output buried in the error.
 * Convex's `adminKey` prepare step is the field case.
 *
 * These tests assert the CALL SHAPE + the output/exit-code contract. Bun's
 * node:http behaviour cannot be reproduced under Node (vitest workers), so
 * "never hijack" is the thing worth locking.
 */

/** Docker's 8-byte multiplexed frame: stream_type | 0 | 0 | 0 | size_be32. */
function frame(stdout: boolean, text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header[0] = stdout ? 1 : 2;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

/** A real docker-modem (never dialed) so demux assertions measure OUR framing
 *  handling, not a hand-rolled fake of the daemon's wire format. */
const realModem = new Dockerode({ socketPath: "/tmp/openship-test-absent.sock" }).modem;

function fakeDaemon(opts: {
  chunks?: Buffer[];
  /** Successive `exec.inspect()` replies; the last one repeats. A reply that is
   *  an Error is THROWN, standing in for a daemon hiccup over the SSH tunnel. */
  inspects?: Array<{ Running: boolean; ExitCode: number | null } | Error>;
  neverEnds?: boolean;
  containerRunning?: boolean;
}) {
  const startOpts: Array<Record<string, unknown>> = [];
  const execArgs: Array<Record<string, unknown>> = [];
  const stream = new PassThrough();
  const inspects = opts.inspects ?? [{ Running: false, ExitCode: 0 }];
  let call = 0;
  const docker = {
    getContainer: () => ({
      inspect: async () => ({
        State: {
          Running: opts.containerRunning ?? true,
          Status: (opts.containerRunning ?? true) ? "running" : "exited",
        },
      }),
      exec: async (args: Record<string, unknown>) => {
        execArgs.push(args);
        return {
          id: "exec-1",
          start: async (o: Record<string, unknown>) => {
            startOpts.push(o);
            // Emit only once the caller has attached its listeners.
            setImmediate(() => {
              for (const chunk of opts.chunks ?? []) stream.write(chunk);
              if (!opts.neverEnds) stream.end();
            });
            return stream;
          },
          inspect: async () => {
            const reply = inspects[Math.min(call++, inspects.length - 1)];
            if (reply instanceof Error) throw reply;
            return reply;
          },
        };
      },
    }),
    modem: realModem,
  };
  return { docker, startOpts, execArgs };
}

/** Run the watchdog argv through a REAL `sh`, exactly as docker would exec it. */
function runWatchdog(
  command: string,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; elapsedMs: number }> {
  const argv = buildInContainerExecCmd(command, timeoutMs);
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1));
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    // `close` (not `exit`) so this also measures when the last writer released
    // the output pipes — the fd-leak the watchdog must not introduce.
    child.on("close", (code) =>
      resolve({ code, stdout, stderr, elapsedMs: Date.now() - startedAt }),
    );
  });
}

async function runtimeWith(docker: unknown): Promise<DockerRuntime> {
  const runtime = await DockerRuntime.create({
    dockerSocketPath: "/tmp/openship-test-absent.sock",
  });
  (runtime as unknown as { _docker: unknown })._docker = docker;
  return runtime;
}

describe("DockerRuntime.inContainerExecutor — exec transport", () => {
  it("NEVER requests a hijacked connection", async () => {
    const { docker, startOpts } = fakeDaemon({ chunks: [frame(true, "ok\n")] });
    const exec = await (await runtimeWith(docker)).inContainerExecutor("c1");
    await exec.exec("echo ok");
    expect(startOpts).toHaveLength(1);
    expect(startOpts[0].hijack).toBeFalsy();
  });

  it("execs the caller's command through the in-container watchdog argv", async () => {
    const { docker, execArgs } = fakeDaemon({ chunks: [frame(true, "ok\n")] });
    const exec = await (await runtimeWith(docker)).inContainerExecutor("c1");
    await exec.exec("echo ok", { timeout: 15_000 });
    expect(execArgs[0].Cmd).toEqual(buildInContainerExecCmd("echo ok", 15_000));
  });

  it("returns demuxed stdout for a successful command, keeping stderr out", async () => {
    // The Convex shape: the key on stdout with a warning interleaved on stderr.
    const { docker } = fakeDaemon({
      chunks: [
        frame(true, "Admin key: "),
        frame(false, "warning: using self-hosted defaults\n"),
        frame(true, "convex-self-hosted|01dabc\n"),
      ],
    });
    const exec = await (await runtimeWith(docker)).inContainerExecutor("c1");
    await expect(exec.exec("generate_admin_key.sh")).resolves.toBe(
      "Admin key: convex-self-hosted|01dabc\n",
    );
  });

  it("reassembles a frame split across chunk boundaries", async () => {
    const full = frame(true, "convex-self-hosted|01dabc\n");
    const { docker } = fakeDaemon({
      // Split mid-HEADER — the worst case for a per-chunk stripper.
      chunks: [full.subarray(0, 3), full.subarray(3, 12), full.subarray(12)],
    });
    const exec = await (await runtimeWith(docker)).inContainerExecutor("c1");
    await expect(exec.exec("cmd")).resolves.toBe("convex-self-hosted|01dabc\n");
  });

  it("passes through output that arrived UNFRAMED", async () => {
    // A daemon/transport that didn't multiplex must not have its first 8 bytes
    // eaten as a header.
    const { docker } = fakeDaemon({ chunks: [Buffer.from("FOUND\nINDEX\n", "utf8")] });
    const exec = await (await runtimeWith(docker)).inContainerExecutor("c1");
    await expect(exec.exec("probe")).resolves.toBe("FOUND\nINDEX\n");
  });

  it("throws with stdout as the message on a non-zero exit", async () => {
    const { docker } = fakeDaemon({
      chunks: [frame(true, "sh: no such file\n")],
      inspects: [{ Running: false, ExitCode: 127 }],
    });
    const exec = await (await runtimeWith(docker)).inContainerExecutor("c1");
    await expect(exec.exec("nope")).rejects.toThrow("sh: no such file");
  });

  it("falls back to stderr when a failing command printed nothing to stdout", async () => {
    const { docker } = fakeDaemon({
      chunks: [frame(false, "permission denied\n")],
      inspects: [{ Running: false, ExitCode: 1 }],
    });
    const exec = await (await runtimeWith(docker)).inContainerExecutor("c1");
    await expect(exec.exec("cat /root/x")).rejects.toThrow("permission denied");
  });

  it("waits for the exec to actually exit instead of reading Running/null as success", async () => {
    // The output stream ends before dockerd marks the exec exited; reading that
    // window as success would hand a FAILED command's output back as the value.
    const { docker } = fakeDaemon({
      chunks: [frame(true, "boom\n")],
      inspects: [
        { Running: true, ExitCode: null },
        { Running: false, ExitCode: 2 },
      ],
    });
    const exec = await (await runtimeWith(docker)).inContainerExecutor("c1");
    await expect(exec.exec("cmd")).rejects.toThrow("boom");
  });

  it("honors the caller's timeout instead of hanging on a stream that never ends", async () => {
    const { docker } = fakeDaemon({ neverEnds: true });
    const exec = await (await runtimeWith(docker)).inContainerExecutor("c1");
    await expect(exec.exec("sleep 999", { timeout: 30 })).rejects.toThrow(/timed out/);
  });

  it("refuses to exec in a container that is not running", async () => {
    const { docker } = fakeDaemon({ containerRunning: false });
    const exec = await (await runtimeWith(docker)).inContainerExecutor("c1");
    await expect(exec.exec("echo hi")).rejects.toThrow(/is not running/);
  });

  // ── exit code: never invented ────────────────────────────────────────────
  //
  // The field failure: `./generate_admin_key.sh` exits 2 printing "boom", the
  // exit-code lookup hiccups on an SSH-tunnelled daemon, and the FAILED
  // command's stdout gets persisted as CONVEX_ADMIN_KEY.

  it("refuses to report success when the exit-code lookup fails outright", async () => {
    const { docker } = fakeDaemon({
      chunks: [frame(true, "boom\n")],
      inspects: [new Error("socket hang up")],
    });
    const exec = await (await runtimeWith(docker)).inContainerExecutor("c1");
    await expect(exec.exec("./generate_admin_key.sh")).rejects.toThrow(/socket hang up/);
  });

  it("refuses to report success when the SECOND lookup (after Running) fails", async () => {
    const { docker } = fakeDaemon({
      chunks: [frame(true, "boom\n")],
      inspects: [{ Running: true, ExitCode: null }, new Error("EPIPE")],
    });
    const exec = await (await runtimeWith(docker)).inContainerExecutor("c1");
    await expect(exec.exec("./generate_admin_key.sh")).rejects.toThrow(/EPIPE/);
  });

  it("refuses to report success for a finished exec with no exit code at all", async () => {
    const { docker } = fakeDaemon({
      chunks: [frame(true, "boom\n")],
      inspects: [{ Running: false, ExitCode: null }],
    });
    const exec = await (await runtimeWith(docker)).inContainerExecutor("c1");
    await expect(exec.exec("./generate_admin_key.sh")).rejects.toThrow(/no exit code/);
  });

  it("fails an exec that never leaves Running, rather than reading it as success", async () => {
    const { docker } = fakeDaemon({
      chunks: [frame(true, "boom\n")],
      inspects: [{ Running: true, ExitCode: null }],
    });
    const exec = await (await runtimeWith(docker)).inContainerExecutor("c1");
    await expect(exec.exec("./generate_admin_key.sh")).rejects.toThrow(/exit code unknown/);
  }, 20_000);

  it("still resolves a genuinely successful exec (exit 0)", async () => {
    const { docker } = fakeDaemon({
      chunks: [frame(true, "convex-self-hosted|01dabc\n")],
      inspects: [{ Running: false, ExitCode: 0 }],
    });
    const exec = await (await runtimeWith(docker)).inContainerExecutor("c1");
    await expect(exec.exec("./generate_admin_key.sh")).resolves.toBe(
      "convex-self-hosted|01dabc\n",
    );
  });
});

describe("buildInContainerExecCmd — the container enforces the deadline", () => {
  it("passes the command as a positional arg, never spliced into the wrapper", () => {
    const nasty = `echo 'it'\\''s $HOME "x"' && exit 0`;
    const argv = buildInContainerExecCmd(nasty, 15_000);
    expect(argv[0]).toBe("sh");
    expect(argv[1]).toBe("-c");
    expect(argv).toContain(nasty);
    // The script itself must not embed the command anywhere.
    expect(argv[2]).not.toContain("echo");
    expect(argv[argv.length - 1]).toBe("15");
  });

  it("rounds the deadline up to whole seconds, floor 1", () => {
    expect(buildInContainerExecCmd("x", 30).at(-1)).toBe("1");
    expect(buildInContainerExecCmd("x", 4_200).at(-1)).toBe("5");
    expect(buildInContainerExecCmd("x", 120_000).at(-1)).toBe("120");
  });

  it("passes stdout, stderr and the exit code through untouched", async () => {
    const r = await runWatchdog("echo out; echo err 1>&2; exit 3", 5_000);
    expect(r.stdout).toBe("out\n");
    expect(r.stderr).toBe("err\n");
    expect(r.code).toBe(3);
  });

  it("does not delay a fast command by holding its output pipe open", async () => {
    // If the watchdog's `sleep` inherited the exec's stdout, EOF would only
    // arrive at the deadline and every probe would cost the full timeout.
    const r = await runWatchdog("echo fast", 5_000);
    expect(r.stdout).toBe("fast\n");
    expect(r.code).toBe(0);
    expect(r.elapsedMs).toBeLessThan(2_000);
  });

  it("kills the command in-container at the deadline instead of orphaning it", async () => {
    const r = await runWatchdog("sleep 30", 1_000);
    expect(r.code).toBe(143); // 128 + SIGTERM
    expect(r.elapsedMs).toBeLessThan(4_000);
    expect(r.stderr).toBe(""); // no shell job-control noise on the timeout path
  }, 10_000);

  it("leaves the command alone when the image has no `sleep` to arm the watchdog", async () => {
    // Degrade to "no watchdog", never to "kill immediately".
    const argv = buildInContainerExecCmd("echo alive", 5_000);
    argv[argv.length - 1] = ""; // an unusable sleep argument stands in for a missing sleep
    const r = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const child = spawn(argv[0], argv.slice(1));
      let stdout = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
      child.on("close", (code) => resolve({ code, stdout }));
    });
    expect(r.stdout).toBe("alive\n");
    expect(r.code).toBe(0);
  });
});

describe("splitDockerFrames", () => {
  it("separates stdout from stderr frames", () => {
    const buf = Buffer.concat([frame(true, "a"), frame(false, "b"), frame(true, "c")]);
    expect(splitDockerFrames(buf)).toEqual([
      { stdout: true, data: Buffer.from("a") },
      { stdout: false, data: Buffer.from("b") },
      { stdout: true, data: Buffer.from("c") },
    ]);
  });

  it("treats an unframed buffer as a single stdout frame", () => {
    expect(splitDockerFrames(Buffer.from("plain text"))).toEqual([
      { stdout: true, data: Buffer.from("plain text") },
    ]);
  });

  it("is empty for empty output", () => {
    expect(splitDockerFrames(Buffer.alloc(0))).toEqual([]);
  });
});
