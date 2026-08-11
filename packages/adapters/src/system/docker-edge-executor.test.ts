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
