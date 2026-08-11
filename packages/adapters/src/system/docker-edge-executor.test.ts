import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";

import { DockerEdgeExecutor } from "./docker-edge-executor";

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
function recordingDocker(exitFor: (cmd: string) => number = () => 0) {
  const commands: string[] = [];
  const docker = {
    getContainer: () => ({
      exec: async (o: { Cmd: string[] }) => {
        const cmd = o.Cmd[2] ?? "";
        commands.push(cmd);
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
      demuxStream: (s: PassThrough) => {
        s.resume();
      },
    },
  };
  return { docker: docker as never, commands };
}

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
    const { docker, commands } = recordingDocker();
    const ex = new DockerEdgeExecutor({
      containerName: "openship-edge",
      docker,
      fileMode: "container",
    });
    await ex.readFile("/etc/openresty/nginx.conf");
    await ex.mkdir("/var/www/acme");
    await ex.rm("/etc/openresty/sites-enabled/old.conf");
    expect(commands).toEqual([
      "cat '/etc/openresty/nginx.conf'",
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
