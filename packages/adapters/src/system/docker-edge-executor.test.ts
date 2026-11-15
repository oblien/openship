import { afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";

import { DockerEdgeExecutor } from "./docker-edge-executor";
import { NginxProvider } from "../infra/nginx";
import { OPENRESTY_DEFAULT_PATHS } from "../infra/openresty-lua";
import { rootChecked } from "./privilege";
import { loopbackPortInventoryFor } from "./proxy/api";
import { framedCatCommand } from "./exact-file-read";

/**
 * Fake daemon: records the options handed to `exec.start` and replays a
 * multiplexed stream, so these tests pin the WIRE CONTRACT rather than dockerode.
 */
function fakeDocker(opts: { exitCode?: number; stdout?: string; stderr?: string } = {}) {
  const startOpts: Array<Record<string, unknown>> = [];
  const stream = new PassThrough();
  const docker = {
    getContainer: () => ({
      exec: async () => ({
        start: async (o: Record<string, unknown>) => {
          startOpts.push(o);
          // Emit after the caller has attached demux + listeners.
          setImmediate(() => stream.end());
          return stream;
        },
        inspect: async () => ({ Running: false, ExitCode: opts.exitCode ?? 0 }),
      }),
    }),
    modem: {
      demuxStream: (s: PassThrough, out: PassThrough, err: PassThrough) => {
        if (opts.stdout) out.write(opts.stdout);
        if (opts.stderr) err.write(opts.stderr);
        // The real demuxStream READS the stream; without a consumer an ended
        // PassThrough never emits 'end' and the executor would wait forever.
        s.resume();
      },
    },
  };
  return { docker: docker as never, startOpts };
}

afterEach(() => {
  vi.useRealTimers(); // safety net for the deadline tests' fake timers
});

describe("DockerEdgeExecutor — exec transport", () => {
  it("NEVER requests a hijacked connection", async () => {
    // Regression lock. Hijack makes docker-modem ask for a connection upgrade; the
    // daemon replies `101 Switching Protocols`, which Bun's node:http doesn't
    // surface the way modem expects — so on the Bun-based api image EVERY edge exec
    // failed with `(HTTP code 101) unexpected`. Config reloads, certbot and site
    // registration all silently died while the edge container looked healthy.
    const { docker, startOpts } = fakeDocker({ stdout: "ok" });
    const ex = new DockerEdgeExecutor({ containerName: "openship-edge", docker });
    await ex.exec("openresty -t");
    expect(startOpts).toHaveLength(1);
    expect(startOpts[0].hijack).toBeFalsy();
  });

  it("returns stdout for a successful command", async () => {
    const { docker } = fakeDocker({ stdout: "configuration file test is successful\n" });
    const ex = new DockerEdgeExecutor({ containerName: "openship-edge", docker });
    await expect(ex.exec("openresty -t")).resolves.toContain("test is successful");
  });

  it("throws with BOTH streams folded in on a non-zero exit", async () => {
    // certbot prints its real cause to stdout while stderr carries boilerplate.
    const { docker } = fakeDocker({ exitCode: 1, stdout: "DNS problem: NXDOMAIN", stderr: "error" });
    const ex = new DockerEdgeExecutor({ containerName: "openship-edge", docker });
    await expect(ex.exec("certbot certonly ...")).rejects.toThrow(/NXDOMAIN/);
  });

  it("does not read a null ExitCode as success", async () => {
    const { docker } = fakeDocker({ exitCode: undefined as unknown as number });
    const ex = new DockerEdgeExecutor({ containerName: "openship-edge", docker });
    // ExitCode null + not Running → 0; the guard that matters is Running:true,
    // covered by the poll loop. Here we just assert it resolves rather than hanging.
    await expect(ex.exec("true")).resolves.toBeDefined();
  });
});

/**
 * Fake daemon that RECORDS every command it's asked to run (and can answer with a
 * per-command exit code), so the container-mode file ops can be pinned to the
 * exact shell they emit.
 */
function recordingDocker(
  exitFor: (cmd: string) => number = () => 0,
  stdoutFor: (cmd: string) => string = () => "",
) {
  const commands: string[] = [];
  let lastCmd = "";
  const docker = {
    getContainer: () => ({
      exec: async (o: { Cmd: string[] }) => {
        const cmd = o.Cmd[2] ?? "";
        commands.push(cmd);
        lastCmd = cmd;
        const stream = new PassThrough();
        return {
          start: async () => {
            setImmediate(() => stream.end());
            return stream;
          },
          inspect: async () => ({ Running: false, ExitCode: exitFor(cmd) }),
        };
      },
    }),
    modem: {
      demuxStream: (s: PassThrough, out: PassThrough) => {
        const stdout = stdoutFor(lastCmd);
        if (stdout) out.write(stdout);
        s.resume();
      },
    },
  };
  return { docker: docker as never, commands };
}

describe("DockerEdgeExecutor — exec timeout enforcement", () => {
  /**
   * A daemon that stalls at a chosen phase: "creation" (container.exec hangs),
   * "start" (exec.start hangs), "inspect" (inspect hangs — output ends so the
   * poll is reached), "stream" (the output stream never ends), or a fully
   * working daemon when nothing stalls.
   */
  function hangingDocker(stall: "creation" | "start" | "inspect" | "stream" | null = null) {
    const stream = new PassThrough();
    const hang = (): Promise<never> => new Promise(() => {});
    const execObj = {
      start:
        stall === "start"
          ? hang
          : async () => {
              if (stall !== "stream") {
                setImmediate(() => stream.end());
              }
              return stream;
            },
      inspect: stall === "inspect" ? hang : async () => ({ Running: false, ExitCode: 0 }),
    };
    const docker = {
      getContainer: () => ({
        exec: stall === "creation" ? hang : async () => execObj,
      }),
      modem: {
        demuxStream: (s: PassThrough) => {
          s.resume();
        },
      },
    };
    return { docker: docker as never, stream };
  }

  it("bounds exec CREATION: a hanging container.exec rejects at the deadline", async () => {
    const { docker } = hangingDocker("creation");
    const ex = new DockerEdgeExecutor({ containerName: "openship-edge", docker });
    await expect(ex.exec("echo hi", { timeout: 150 })).rejects.toThrow(/while creating the exec/);
  });

  it("bounds exec START: a hanging exec.start rejects at the deadline", async () => {
    const { docker } = hangingDocker("start");
    const ex = new DockerEdgeExecutor({ containerName: "openship-edge", docker });
    await expect(ex.exec("echo hi", { timeout: 150 })).rejects.toThrow(/while starting the exec/);
  });

  it("bounds the OUTPUT wait and destroys the stream when the exec stalls silently", async () => {
    const { docker, stream } = hangingDocker("stream");
    const ex = new DockerEdgeExecutor({ containerName: "openship-edge", docker });
    await expect(
      ex.exec("python3 -c probe", { timeout: 150 }),
    ).rejects.toThrow(/command timed out after 150ms while waiting for output/);
    expect(stream.destroyed).toBe(true); // cancellation tore the pipe down
  });

  it("bounds each INSPECTION: a hanging inspect rejects at the deadline", async () => {
    const { docker } = hangingDocker("inspect");
    const ex = new DockerEdgeExecutor({ containerName: "openship-edge", docker });
    await expect(ex.exec("openresty -t", { timeout: 150 })).rejects.toThrow(/while inspecting the exec/);
  });

  it("resolves normally when the command completes within the timeout", async () => {
    const { docker } = hangingDocker(null);
    const ex = new DockerEdgeExecutor({ containerName: "openship-edge", docker });
    await expect(ex.exec("echo done", { timeout: 2000 })).resolves.toBe("");
  });

  it("bounds edge-down DIAGNOSTICS by the remaining deadline — a 409 followed by a stalled inspection falls back to the original error", async () => {
    // The daemon refuses the exec with a 409 (edge-down signature), and the
    // diagnostic inspection (explainDown → container.inspect) then HANGS.
    // Without the bound the call stays pending far past the caller's timeout.
    const hang = (): Promise<never> => new Promise(() => {});
    const failingDocker = {
      getContainer: () => ({
        exec: async () => {
          throw new Error("(HTTP code 409) unexpected — edge container missing");
        },
        inspect: hang, // explainDown's diagnostic hangs forever
        logs: hang,
      }),
      modem: { demuxStream: (s: PassThrough) => s.resume() },
    };
    const ex = new DockerEdgeExecutor({ containerName: "openship-edge", docker: failingDocker as never });
    // Fake timers make boundedness deterministic: the deadline timer fires
    // exactly when advanced, immune to parallel-suite event-loop congestion.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const expectation = expect(ex.exec("echo hi", { timeout: 50 })).rejects.toThrow(/409/); // handler attached BEFORE the clock advances
    await vi.advanceTimersByTimeAsync(50); // the whole budget: diagnostics stall
    await expectation;
    vi.useRealTimers();
  });

  it("still delivers edge-down diagnostics when they complete within the deadline", async () => {
    // Diagnostic inspection resolves in time: the enriched explanation wins,
    // not the fallback.
    const docker = {
      getContainer: () => ({
        exec: async () => {
          throw new Error("(HTTP code 409) unexpected");
        },
        inspect: async () => ({ State: { Status: "restarting" } }),
        logs: async () => Buffer.from("nginx: [emerg] host not found in upstream"),
      }),
      modem: { demuxStream: (s: PassThrough) => s.resume() },
    };
    const ex = new DockerEdgeExecutor({ containerName: "openship-edge", docker: docker as never });
    await expect(ex.exec("echo hi", { timeout: 500 })).rejects.toThrow(/restarting/);
  });

  it("bounds exit-path DIAGNOSTICS too — completed command with edge-down output plus a stalled inspection", async () => {
    // The command RAN and exited 1 with "invalid PID number" output (the
    // restart-under-us case), so run() completes — and the exit-path
    // explainDown then hangs on a stalled inspection. With a 50ms timeout the
    // call must reject with the command's own detail inside the bound, not
    // pend on diagnostics.
    const hang = (): Promise<never> => new Promise(() => {});
    const multiplexed = new PassThrough();
    const docker = {
      getContainer: () => ({
        exec: async () => ({
          start: async () => multiplexed,
          inspect: async () => ({ Running: false, ExitCode: 1 }),
        }),
        inspect: hang, // explainDown's diagnostic hangs forever
        logs: hang,
      }),
      modem: {
        demuxStream: (s: PassThrough, out: PassThrough, _err: PassThrough) => {
          // Fake demux, SYNCHRONOUS: the "daemon" hands over the payload the
          // moment the executor attaches the demux pipe. (Timers/ immediates
          // interact badly with the fake-clock advance loop.)
          s.resume();
          out.write("nginx: [emerg] invalid PID number \" \" in /usr/local/openresty/nginx/conf/nginx.conf\n");
          s.end();
        },
      },
    };
    const ex = new DockerEdgeExecutor({ containerName: "openship-edge", docker: docker as never });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const expectation = expect(
      ex.exec("openresty -s reload", { timeout: 50 }),
    ).rejects.toThrow(/invalid PID number/); // handler attached BEFORE the clock advances
    await vi.advanceTimersByTimeAsync(50); // command completed; diagnostics stall
    await expectation;
    vi.useRealTimers();
  });

  it("ONE deadline spans execution and diagnostics — execution consuming most of the budget leaves diagnostics only the remainder", async () => {
    // Reproduction: the command ran ~140ms of a 200ms budget, exited with
    // edge-down output, and diagnostics got a FRESH 200ms — 354ms total. With
    // one absolute deadline the whole call must land at ~200ms.
    const hang = (): Promise<never> => new Promise(() => {});
    const multiplexed = new PassThrough();
    const docker = {
      getContainer: () => ({
        exec: async () => ({
          start: async () => {
            setTimeout(() => {
              multiplexed.write("nginx: [emerg] invalid PID number \" \" in /usr/local/openresty/nginx/conf/nginx.conf\n");
              multiplexed.end();
            }, 140); // execution consumes most of the budget
            return multiplexed;
          },
          inspect: async () => ({ Running: false, ExitCode: 1 }),
        }),
        inspect: hang, // diagnostics stall forever
        logs: hang,
      }),
      modem: {
        demuxStream: (s: PassThrough, out: PassThrough, _err: PassThrough) => {
          s.resume();
          s.on("data", (chunk: Buffer) => out.write(chunk));
          s.on("end", () => out.end());
        },
      },
    };
    const ex = new DockerEdgeExecutor({ containerName: "openship-edge", docker: docker as never });
    // Fake timers turn the fresh-vs-shared discrimination STRUCTURAL: the
    // 140ms execution timer fires only when advanced, and a fresh diagnostic
    // budget (started at t=140 with 200ms) would reject at t=340 — never at
    // t=200. The shared deadline rejects exactly at t=200.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let rejected: unknown = null;
    const pending = ex.exec("openresty -s reload", { timeout: 200 }).catch((err: unknown) => {
      rejected = err;
    });
    await vi.advanceTimersByTimeAsync(140); // execution consumes most of the budget
    await vi.advanceTimersByTimeAsync(59); // t=199: one ms of budget left
    expect(rejected).toBeNull(); // diagnostics did NOT get a fresh 200ms
    await vi.advanceTimersByTimeAsync(1); // t=200: the absolute deadline fires
    await pending;
    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).message).toMatch(/invalid PID number/);
    vi.useRealTimers();
  });

  it("observes an already-started operation when rejecting immediately on an expired budget — no unhandled rejection", async () => {
    // The deadline racer receives operations that are ALREADY in flight (the
    // caller created the promise before calling). When the budget is spent the
    // racer rejects immediately — and must still observe the started
    // operation, or its LATER failure becomes an unhandledRejection
    // (reproduced: an exit inspection failing after the deadline).
    const ex = new DockerEdgeExecutor({ containerName: "openship-edge", docker: fakeDocker() as never });
    let failLater: (err: Error) => void = () => {};
    const lateFailure = new Promise<never>((_, reject) => {
      failLater = reject;
    });
    const racer = (
      ex as unknown as {
        withDeadlineOp: (op: Promise<never>, phase: string, timeoutMs?: number) => Promise<never>;
      }
    ).withDeadlineOp(lateFailure, "inspecting the exec", 0);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      // Immediate phase timeout — the started operation is abandoned.
      await expect(racer).rejects.toThrow(/timed out .* while inspecting the exec/);
      // The abandoned operation then FAILS, well after the deadline.
      failLater(new Error("exit inspection failed after the deadline"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("reports the caller's REQUESTED timeout in the message, not the drifting remaining budget", async () => {
    // Phases share one absolute deadline, so the remaining time shrinks toward
    // 0 — a message built from it would say "after 187ms" once and "after 3ms"
    // the next. The racer rejects with the requested budget instead.
    const ex = new DockerEdgeExecutor({ containerName: "openship-edge", docker: fakeDocker() as never });
    const racer = (
      ex as unknown as {
        withDeadlineOp: (
          op: Promise<never>,
          phase: string,
          timeoutMs?: number,
          command?: string,
          budgetMs?: number,
        ) => Promise<never>;
      }
    ).withDeadlineOp(new Promise<never>(() => {}), "inspecting the exec", 5, "openresty -s reload", 200);
    await expect(racer).rejects.toThrow(/command timed out after 200ms while inspecting the exec in edge container openship-edge: openresty -s reload/);
  });

  it("survives modem's demux pipe erroring the outputs after they were collected — no uncaught stream error", async () => {
    // run() collects stdout/stderr into PassThroughs and `end()`s them once the
    // demux source ends. The daemon (or modem tearing the pipe down after our
    // stream.destroy() on deadline expiry) can still write/error those streams
    // afterwards; with no 'error' listener that raises an UNCAUGHT stream error
    // and crashes the process instead of completing the command.
    const multiplexed = new PassThrough();
    const docker = {
      getContainer: () => ({
        exec: async () => ({
          start: async () => {
            multiplexed.end("probe output\n");
            return multiplexed;
          },
          inspect: async () => ({ Running: false, ExitCode: 0 }),
        }),
        inspect: async () => ({ Running: false, ExitCode: 0 }),
        logs: async () => Buffer.from(""),
      }),
      modem: {
        demuxStream: (s: PassThrough, out: PassThrough, _err: PassThrough) => {
          s.on("data", (chunk: Buffer) => out.write(chunk));
          // Emulate modem's late flush after the source ended: run() has
          // already end()ed `out` by then (microtask before macrotask), so
          // this write-after-end must raise — and must be swallowed.
          s.on("end", () => {
            setTimeout(() => out.write("late chunk from the daemon\n"), 10);
          });
        },
      },
    };
    const ex = new DockerEdgeExecutor({ containerName: "openship-edge", docker: docker as never });
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown): void => {
      uncaught.push(err);
    };
    process.on("uncaughtException", onUncaught);
    try {
      // The command itself completes normally; the late write lands after.
      await expect(ex.exec("probe", { timeout: 500 })).resolves.toBe("probe output");
      await new Promise((resolve) => setTimeout(resolve, 60)); // let the late flush land
      expect(uncaught).toHaveLength(0);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  it("stays unbounded without a timeout (certbot runs long)", async () => {
    // The output stream ends late; without a deadline the wait survives past
    // any implicit bound and completes through the exit poll.
    const stream = new PassThrough();
    const docker = {
      getContainer: () => ({
        exec: async () => ({
          start: async () => {
            setTimeout(() => stream.end(), 200);
            return stream;
          },
          inspect: async () => ({ Running: false, ExitCode: 0 }),
        }),
      }),
      modem: {
        demuxStream: (s: PassThrough) => {
          s.resume();
        },
      },
    };
    const ex = new DockerEdgeExecutor({ containerName: "openship-edge", docker: docker as never });
    const promise = ex.exec("certbot renew");
    const raced = await Promise.race([
      promise.then(() => "resolved"),
      new Promise((r) => setTimeout(() => r("still-waiting"), 100)),
    ]);
    expect(raced).toBe("still-waiting"); // not killed at some implicit bound
    await expect(promise).resolves.toBeDefined();
  });
});

describe("DockerEdgeExecutor — container file mode", () => {
  // A remote edge is reachable ONLY through the daemon: the routing volumes are
  // on that host, not in this process. So file ops must go over `docker exec`
  // rather than node:fs, which would silently read/write the WRONG machine.
  it("writes a file through the daemon, creating its directory first", async () => {
    const { docker, commands } = recordingDocker();
    const ex = new DockerEdgeExecutor({
      containerName: "openship-edge",
      docker,
      fileMode: "container",
    });
    await ex.writeFile("/etc/openresty/sites-enabled/app.conf", "server { listen 80; }");

    expect(commands[0]).toBe("mkdir -p '/etc/openresty/sites-enabled'");
    // Content travels base64-encoded IN the command — `run()` never hijacks the
    // connection (it breaks under Bun), so there is no stdin to pipe through.
    const write = commands[1];
    expect(write).toMatch(/^printf '%s' '[A-Za-z0-9+/=]+' \| base64 -d > '\/etc\/openresty\/sites-enabled\/app\.conf'$/);
    const b64 = write.match(/'([A-Za-z0-9+/=]+)'/)![1];
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe("server { listen 80; }");
  });

  it("chunks a large write and appends after the first command", async () => {
    const { docker, commands } = recordingDocker();
    const ex = new DockerEdgeExecutor({
      containerName: "openship-edge",
      docker,
      fileMode: "container",
    });
    await ex.writeFile("/tmp/big.conf", "x".repeat(200_000));

    const writes = commands.filter((c) => c.startsWith("printf"));
    expect(writes.length).toBeGreaterThan(1);
    expect(writes[0]).toContain("> '/tmp/big.conf'");
    expect(writes[0]).not.toContain(">> '/tmp/big.conf'");
    // Every later chunk MUST append, or the file ends up holding only the tail.
    for (const w of writes.slice(1)) expect(w).toContain(">> '/tmp/big.conf'");
  });

  it("truncates for empty content instead of emitting a base64 command", async () => {
    const { docker, commands } = recordingDocker();
    const ex = new DockerEdgeExecutor({
      containerName: "openship-edge",
      docker,
      fileMode: "container",
    });
    await ex.writeFile("/tmp/empty.conf", "");
    expect(commands).toContain(": > '/tmp/empty.conf'");
    expect(commands.some((c) => c.startsWith("printf"))).toBe(false);
  });

  it("reports a missing path as false rather than throwing", async () => {
    // `test -e` answers by exit code — absence is an answer, not a failure.
    const { docker } = recordingDocker((cmd) => (cmd.startsWith("test -e") ? 1 : 0));
    const ex = new DockerEdgeExecutor({
      containerName: "openship-edge",
      docker,
      fileMode: "container",
    });
    await expect(ex.exists("/etc/letsencrypt/live/app.example.com")).resolves.toBe(false);
  });

  it("reads, mkdirs and removes through the daemon", async () => {
    const conf = "\nhttp {\n}\n";
    const { docker, commands } = recordingDocker(
      () => 0,
      (cmd) => (cmd === framedCatCommand("/etc/openresty/nginx.conf") ? `<openship-file>${conf}</openship-file>` : ""),
    );
    const ex = new DockerEdgeExecutor({
      containerName: "openship-edge",
      docker,
      fileMode: "container",
    });
    // Byte-exact: exec trims its output, which must not reach the file content.
    expect(await ex.readFile("/etc/openresty/nginx.conf")).toBe(conf);
    await ex.mkdir("/var/www/acme");
    await ex.rm("/etc/openresty/sites-enabled/old.conf");
    expect(commands).toEqual([
      framedCatCommand("/etc/openresty/nginx.conf"),
      "mkdir -p '/var/www/acme'",
      "rm -rf '/etc/openresty/sites-enabled/old.conf'",
    ]);
  });

  it("refuses transferIn — there is no local source across a remote daemon", async () => {
    const { docker } = recordingDocker();
    const ex = new DockerEdgeExecutor({
      containerName: "openship-edge",
      docker,
      fileMode: "container",
    });
    await expect(ex.transferIn("/tmp/a", "/tmp/b")).rejects.toThrow(/not supported/i);
  });

  it("defaults to mounted mode — unchanged for the compose-local edge", async () => {
    const { docker, commands } = recordingDocker();
    const ex = new DockerEdgeExecutor({ containerName: "openship-edge", docker });
    // node:fs on a path that doesn't exist → rejects WITHOUT touching the daemon.
    await expect(ex.readFile("/definitely/not/here.conf")).rejects.toThrow();
    expect(commands).toEqual([]);
  });
});

const CRASH_LOG =
  `2026/08/03 14:13:37 [notice] 1#1: using the "epoll" event method\n` +
  `2026/08/03 14:13:37 [emerg] 1#1: cannot load certificate ` +
  `"/etc/letsencrypt/live/test.hekai.org/fullchain.pem": BIO_new_file() failed`;

/**
 * Fake daemon whose container is NOT up. Same failure the shell transport sees, over
 * the other channel: the daemon refuses the exec (`refuse`) or the command itself
 * reports the edge as absent (`exitCode` + `stdout`). `probesFail` makes the
 * diagnosis reads die too, which is how a dead socket behaves.
 */
function downDocker(opts: {
  refuse?: string;
  exitCode?: number;
  stdout?: string;
  status?: string;
  logs?: string;
  probesFail?: boolean;
}) {
  const probes: string[] = [];
  const container = {
    exec: async () => {
      if (opts.refuse) throw new Error(opts.refuse);
      const stream = new PassThrough();
      return {
        start: async () => {
          setImmediate(() => stream.end());
          return stream;
        },
        inspect: async () => ({ Running: false, ExitCode: opts.exitCode ?? 0 }),
      };
    },
    inspect: async () => {
      probes.push("inspect");
      if (opts.probesFail) throw new Error("socket hang up");
      return { State: { Status: opts.status ?? "restarting" } };
    },
    logs: async () => {
      probes.push("logs");
      if (opts.probesFail) throw new Error("socket hang up");
      return Buffer.from(opts.logs ?? CRASH_LOG);
    },
  };
  const docker = {
    getContainer: () => container,
    modem: {
      demuxStream: (s: PassThrough, out: PassThrough) => {
        if (opts.stdout) out.write(opts.stdout);
        s.resume();
      },
    },
  };
  return { docker: docker as never, probes };
}

/**
 * The dockerode half of the same fix. This transport used to report the condition as
 * `(HTTP code 409) … container <64-hex-id> is not running`: the resolved id, no name,
 * no cause — six identical 409s during an `openship up` migration while the edge was
 * still coming up, and from the cert flow a container the operator had no reason to
 * think was involved.
 */
describe("DockerEdgeExecutor — the edge container is down", () => {
  const RESTARTING =
    "(HTTP code 409) unexpected - Container b8968804d6a78cb51ae5151a0840eff7428b4a778380838c580c9f852d5771c7 " +
    "is restarting, wait until the container is running";

  it("names the container, its state and the [emerg] when the daemon refuses the exec", async () => {
    const { docker, probes } = downDocker({ refuse: RESTARTING });
    const ex = new DockerEdgeExecutor({ containerName: "openship-edge", docker });

    await expect(ex.exec("certbot certonly")).rejects.toThrow(
      /the edge container is not running \("openship-edge"\) \(restarting\)/,
    );
    await expect(ex.exec("certbot certonly")).rejects.toThrow(/cannot load certificate/);
    // Read through the daemon API, not a shell — the whole reason `edgeFailureReason`
    // is a pure parser is that the two transports share the parsing, not the channel.
    expect(probes).toEqual(["inspect", "logs", "inspect", "logs"]);
  });

  // The discrimination that keeps this fix from causing a worse bug than it fixes.
  it("passes a genuine transport error through untouched", async () => {
    // The documented Bun failure: hijack → daemon answers `101 Switching Protocols`,
    // which Bun's node:http doesn't surface the way modem expects. Diagnosing THAT as
    // "the edge is down" would send an operator to restart a perfectly healthy edge.
    const { docker, probes } = downDocker({ refuse: "(HTTP code 101) unexpected - upgrade failed" });
    const ex = new DockerEdgeExecutor({ containerName: "openship-edge", docker });

    await expect(ex.exec("openresty -t")).rejects.toThrow(/HTTP code 101/);
    await expect(ex.exec("openresty -t")).rejects.not.toThrow(/edge container is not running/);
    expect(probes).toEqual([]);
  });

  it("diagnoses an empty pid file — the exec RAN, and the master was already gone", async () => {
    // openresty is PID 1 in the container, so `-s reload` finding an empty pid file
    // means the container is going down under us. It arrives right after "test is
    // successful", which is exactly why it reads as a config problem instead.
    const { docker } = downDocker({
      exitCode: 1,
      stdout:
        `nginx: configuration file /usr/local/openresty/nginx/conf/nginx.conf test is successful\n` +
        `nginx: [error] invalid PID number "" in "/usr/local/openresty/nginx/logs/nginx.pid"`,
    });
    const ex = new DockerEdgeExecutor({ containerName: "openship-edge", docker });

    await expect(ex.exec("openresty -s reload")).rejects.toThrow(
      /the edge container is not running.*cannot load certificate/s,
    );
  });

  it("leaves an ordinary non-zero exit as certbot's own diagnosis", async () => {
    const { docker, probes } = downDocker({
      exitCode: 1,
      stdout: "Detail: DNS problem: NXDOMAIN looking up A for test.hekai.org",
    });
    const ex = new DockerEdgeExecutor({ containerName: "openship-edge", docker });

    await expect(ex.exec("certbot certonly")).rejects.toThrow(/NXDOMAIN/);
    await expect(ex.exec("certbot certonly")).rejects.not.toThrow(/edge container is not running/);
    expect(probes).toEqual([]);
  });

  it("streams ONE explanation line so the caller's built error carries it", async () => {
    const { docker } = downDocker({ exitCode: 1, stdout: RESTARTING });
    const ex = new DockerEdgeExecutor({ containerName: "openship-edge", docker });

    const lines: string[] = [];
    const result = await ex.streamExec("certbot certonly", (log) => lines.push(log.message));

    const explanation = lines.find((l) => l.includes("the edge container is not running"));
    expect(explanation).toBeDefined();
    // Single line by construction: this string is joined into a deploy warning and fed
    // to certbot's summarizer, whose fallback keeps only the last three lines.
    expect(explanation).not.toContain("\n");
    expect(result.code).toBe(1);
    expect(result.output.startsWith(explanation!)).toBe(true);
  });

  it("still names the container when the diagnosis reads fail too", async () => {
    const { docker } = downDocker({ refuse: RESTARTING, probesFail: true });
    const ex = new DockerEdgeExecutor({ containerName: "openship-edge", docker });

    await expect(ex.exec("openresty -t")).rejects.toThrow(
      /the edge container is not running \("openship-edge"\) — .*docker logs --tail 40 openship-edge/,
    );
  });
});

describe("socket edge port inventory", () => {
  const config = `http {
    upstream legacy { server 127.0.0.1:20000; server [::1]:20001; }
    server { listen 80; server_name _;
      location / { proxy_pass http://legacy; }
      location /private { proxy_pass http://127.0.0.2:20002; }
      location /remote { proxy_pass http://10.0.0.9:3000; }
    }
  }`;
  function inventory(stdout: string, exitCode = 0) {
    const { docker } = fakeDocker({
      stdout,
      exitCode,
      stderr: exitCode ? "edge config unreadable" : "",
    });
    const executor = new DockerEdgeExecutor({ containerName: "openship-edge", docker });
    const routing = new NginxProvider({
      paths: OPENRESTY_DEFAULT_PATHS,
      containerEdge: true,
      executor: rootChecked(executor, "test socket edge"),
    });
    const host = {
      exec: vi.fn(async () => {
        throw new Error("host channel unavailable");
      }),
    };
    return { routing, host, reader: loopbackPortInventoryFor(routing, host as never) };
  }

  it("reads all stale upstreams through Docker even when the host channel refuses", async () => {
    const { reader, host } = inventory(config);
    expect(await reader.listLoopbackUpstreamPortsStrict()).toEqual(new Set([20000, 20001, 20002]));
    expect(host.exec).not.toHaveBeenCalled();
  });

  it("accepts a verified edge with no loopback upstreams", async () => {
    const { reader } = inventory("http { server { listen 80; return 404; } }");
    await expect(reader.listLoopbackUpstreamPortsStrict()).resolves.toEqual(new Set());
  });

  it("keeps host-side detection for an SSH-managed edge", async () => {
    const host = {
      exec: vi.fn(async (command: string) => {
        if (command.includes("docker ps -a"))
          return "openship-edge\tghcr.io/openship/edge:latest\trunning";
        if (command.includes("openresty -T")) return config;
        return "";
      }),
    };
    const edge = {
      exec: vi.fn(async () => {
        throw new Error("wrong namespace");
      }),
    };
    const routing = new NginxProvider({
      paths: OPENRESTY_DEFAULT_PATHS,
      containerEdge: true,
      hostExecutor: host as never,
      executor: rootChecked(edge as never, "test remote edge"),
    });
    await expect(routing.listLoopbackUpstreamPortsStrict()).resolves.toEqual(
      new Set([20000, 20001, 20002]),
    );
    expect(edge.exec).not.toHaveBeenCalled();
    expect(host.exec).toHaveBeenCalled();
  });

  it.each([
    "",
    "# server { only a comment }",
    "http { server { location / { proxy_pass http://$host:20000; } } }",
  ])("rejects an empty or ambiguous resolved dump (%s)", async (dump) => {
    const { reader, host } = inventory(dump);
    await expect(reader.listLoopbackUpstreamPortsStrict()).rejects.toThrow(
      /Cannot (read|inventory) Openship edge routes/,
    );
    expect(host.exec).not.toHaveBeenCalled();
  });

  it("propagates a failed Docker exec instead of claiming the edge has no routes", async () => {
    await expect(inventory(config, 1).reader.listLoopbackUpstreamPortsStrict()).rejects.toThrow(
      "edge config unreadable",
    );
  });
});

describe("DockerEdgeExecutor.lstat", () => {
  it("reports type and mode through the mount in mounted mode", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "openship-edge-lstat-"));
    try {
      await writeFile(join(dir, "a.conf"), "x", { mode: 0o600 });
      const { docker } = recordingDocker();
      const ex = new DockerEdgeExecutor({
        containerName: "openship-edge",
        docker,
        fileMode: "mounted",
      });
      expect(await ex.lstat!(join(dir, "a.conf"))).toEqual({ kind: "file", mode: 0o600 });
      expect(await ex.lstat!(join(dir, "missing.conf"))).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not advertise file metadata in container file mode", () => {
    const { docker } = recordingDocker();
    const ex = new DockerEdgeExecutor({
      containerName: "openship-edge",
      docker,
      fileMode: "container",
    });
    expect(ex.lstat).toBeUndefined();
  });
});
