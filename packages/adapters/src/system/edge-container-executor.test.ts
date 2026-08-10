import { describe, expect, it, vi, type Mock } from "vitest";

import {
  containerCommand,
  edgeContainerExecutor,
  readEdgeFile,
  readMaybeInContainer,
  writeEdgeFile,
} from "./edge-container-executor";
import { logEntry } from "./local-shell";
import type { CommandExecutor, LogEntry } from "../types";

function fakeExecutor(overrides: Partial<CommandExecutor> = {}): CommandExecutor {
  return {
    exec: vi.fn(async () => ""),
    streamExec: vi.fn(async () => ({ code: 0, output: "" })),
    writeFile: vi.fn(async () => {}),
    readFile: vi.fn(async () => ""),
    exists: vi.fn(async () => false),
    mkdir: vi.fn(async () => {}),
    rm: vi.fn(async () => {}),
    transferIn: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    ...overrides,
  } as unknown as CommandExecutor;
}

/** Every command string the executor was asked to run. */
function execCalls(exec: CommandExecutor): string[] {
  return (exec.exec as unknown as Mock).mock.calls.map(([cmd]) => cmd as string);
}

describe("containerCommand", () => {
  it("wraps the command for docker exec", () => {
    expect(containerCommand("openship-edge", "openresty -t")).toBe(
      "docker exec 'openship-edge' sh -c 'openresty -t'",
    );
  });

  it("quotes a command that itself contains single quotes", () => {
    // The reload command embeds `pkill -f '[o]penresty'`; naive interpolation would
    // close the outer quote and hand the rest of it to the host shell.
    const wrapped = containerCommand("openship-edge", `pkill -f '[o]penresty'`);
    expect(wrapped).toBe(`docker exec 'openship-edge' sh -c 'pkill -f '\\''[o]penresty'\\'''`);
  });
});

describe("edgeContainerExecutor", () => {
  it("runs commands in the container but leaves file ops on the host", async () => {
    const inner = fakeExecutor();
    const edge = edgeContainerExecutor(inner, "openship-edge");

    await edge.exec("openresty -s reload");
    await edge.writeFile("/var/lib/openship/edge/sites-enabled/app.conf", "server {}");

    expect(inner.exec).toHaveBeenCalledWith(
      "docker exec 'openship-edge' sh -c 'openresty -s reload'",
      undefined,
    );
    // Host path, host write — this is what keeps the migrate scan and cert reuse
    // able to see what the edge serves.
    expect(inner.writeFile).toHaveBeenCalledWith(
      "/var/lib/openship/edge/sites-enabled/app.conf",
      "server {}",
    );
  });

  it("streams through the container too (certbot output)", async () => {
    const inner = fakeExecutor();
    const onLog = vi.fn();
    await edgeContainerExecutor(inner, "openship-edge").streamExec("certbot certonly", onLog);

    // The opts (abort signal) forward through transparently — undefined here since
    // this caller passes none, but the live-log transport relies on it reaching the
    // inner executor so an aborted stream kills the curl inside the container.
    expect(inner.streamExec).toHaveBeenCalledWith(
      "docker exec 'openship-edge' sh -c 'certbot certonly'",
      onLog,
      undefined,
    );
  });

  it('falls back into the container in files:"auto" mode', async () => {
    // Legacy install: the host read comes back empty because the state is in a
    // named volume, so the answer has to come from inside the container.
    const inner = fakeExecutor({ readFile: vi.fn(async () => ""), exec: vi.fn(async () => "pem") });
    const edge = edgeContainerExecutor(inner, "openship-edge", { files: "auto" });

    expect(await edge.readFile("/etc/letsencrypt/live/a/fullchain.pem")).toBe("pem");
    expect(inner.exec).toHaveBeenCalledWith(
      "docker exec 'openship-edge' sh -c 'cat '\\''/etc/letsencrypt/live/a/fullchain.pem'\\'''",
    );
  });

  it('files:"auto" prefers the host and never touches the container when it answers', async () => {
    const inner = fakeExecutor({ readFile: vi.fn(async () => "host-pem") });
    const edge = edgeContainerExecutor(inner, "openship-edge", { files: "auto" });

    expect(await edge.readFile("/etc/letsencrypt/live/a/fullchain.pem")).toBe("host-pem");
    expect(inner.exec).not.toHaveBeenCalled();
  });

  it('files:"auto" resolves NO container itself — it reuses the one it was built with', async () => {
    // The whole point of the mode: the container is already known, so this must not
    // re-probe `docker ps` per file the way the standalone helpers have to.
    const inner = fakeExecutor({ readFile: vi.fn(async () => "") });
    await edgeContainerExecutor(inner, "openship-edge", { files: "auto" }).readFile("/x");
    expect(execCalls(inner).some((c) => c.startsWith("docker ps"))).toBe(false);
  });

  // The routing failure this guards: an atomic vhost write is writeFile(tmp) on the
  // HOST + rename(tmp, final). Sending the rename through this decorator's `exec`
  // put the `mv` inside the container, where the host path doesn't exist — ENOENT on
  // a file that had just been written, and routing silently down.
  it("renames on the HOST, never inside the container", async () => {
    const renamed: Array<[string, string]> = [];
    const inner = fakeExecutor({ rename: vi.fn(async (a: string, b: string) => { renamed.push([a, b]); }) });
    const wrapped = edgeContainerExecutor(inner, "openship-edge");

    await wrapped.rename!(
      "/var/lib/openship/edge/sites-enabled/x.conf.tmp-1",
      "/var/lib/openship/edge/sites-enabled/x.conf",
    );

    expect(renamed).toEqual([[
      "/var/lib/openship/edge/sites-enabled/x.conf.tmp-1",
      "/var/lib/openship/edge/sites-enabled/x.conf",
    ]]);
    expect(execCalls(inner)).toEqual([]); // no docker exec at all
  });

  it("falls back to the inner SHELL when the inner has no rename", async () => {
    const inner = fakeExecutor();
    delete (inner as { rename?: unknown }).rename;
    const wrapped = edgeContainerExecutor(inner, "openship-edge");

    await wrapped.rename!("/host/path/a.tmp", "/host/path/a");

    // The inner shell (the host), NOT `docker exec` — that's the whole point.
    expect(execCalls(inner)).toEqual(["mv '/host/path/a.tmp' '/host/path/a'"]);
  });

  it("forwards unknown methods to the inner executor", async () => {
    const inner = fakeExecutor();
    const edge = edgeContainerExecutor(inner, "openship-edge");
    await edge.dispose?.();
    expect(inner.dispose).toHaveBeenCalled();
  });
});

/**
 * What an operator is told when the edge itself is down.
 *
 * The failure this fixes, verbatim from a live box: a STATIC app's cert flow printed
 * `Error response from daemon: Container b8968804d6a7…5771c7 is restarting, wait until
 * the container is running` — the daemon's resolved 64-hex id, no name, no cause. A
 * static project has no container of its own (the edge serves it from the shared
 * volume), so read from there it looks like we went hunting for a container that
 * shouldn't exist. We didn't: certbot runs INSIDE the edge, and the edge was crash-looping.
 */
describe("edgeContainerExecutor — the edge container is down", () => {
  const RESTARTING =
    "Error response from daemon: Container b8968804d6a78cb51ae5151a0840eff7428b4a778380838c580c9f852d5771c7 " +
    "is restarting, wait until the container is running";
  const CRASH_LOG =
    `2026/08/03 14:13:37 [notice] 1#1: using the "epoll" event method\n` +
    `2026/08/03 14:13:37 [emerg] 1#1: cannot load certificate ` +
    `"/etc/letsencrypt/live/test.hekai.org/fullchain.pem": BIO_new_file() failed`;

  /** Inner executor of a box whose edge is crash-looping on a missing cert. */
  function crashLoopingHost(): CommandExecutor {
    return fakeExecutor({
      exec: vi.fn(async (cmd: string) => {
        if (cmd.startsWith("docker inspect")) return "restarting\n";
        if (cmd.startsWith("docker logs")) return CRASH_LOG;
        throw new Error(RESTARTING);
      }),
    });
  }

  it("rewrites the daemon's bare container id into the name, the state and the cause", async () => {
    const inner = crashLoopingHost();
    const edge = edgeContainerExecutor(inner, "openship-edge");

    await expect(edge.exec("certbot certonly --standalone")).rejects.toThrow(
      /the edge container is not running \("openship-edge"\) \(restarting\)/,
    );
    // The three things the daemon's message lacked, and the operator needs.
    await expect(edge.exec("certbot certonly --standalone")).rejects.toThrow(/crash-looping/);
    await expect(edge.exec("certbot certonly --standalone")).rejects.toThrow(
      /cannot load certificate/,
    );
    // The original is kept below the explanation — never swallowed.
    await expect(edge.exec("certbot certonly --standalone")).rejects.toThrow(/is restarting, wait/);
  });

  it("diagnoses over the SAME channel the failed command went out on", async () => {
    // A remote server: the inner executor is the pooled SSH one, so the probes must
    // be shell commands on that host. A second Docker client or a tunnel here would
    // mean a remote edge could never be diagnosed at all.
    const inner = crashLoopingHost();
    await edgeContainerExecutor(inner, "openship-edge").exec("openresty -t").catch(() => {});

    expect(execCalls(inner)).toEqual([
      "docker exec 'openship-edge' sh -c 'openresty -t'",
      "docker inspect -f '{{.State.Status}}' 'openship-edge' 2>/dev/null",
      "docker logs --tail 40 'openship-edge' 2>&1",
    ]);
  });

  // The cost guard, and the reason enrichment is gated instead of unconditional: a
  // non-zero exit is ORDINARY here. `files:"auto"` probes container paths with
  // `test -e` and `cat`, which report absence by failing — paying two extra `docker`
  // round-trips per read miss would be a real cost on a healthy box.
  it("adds no round-trips — and no rewriting — to an ordinary failed command", async () => {
    const boom = new Error("cat: /etc/letsencrypt/live/a/fullchain.pem: No such file or directory");
    const inner = fakeExecutor({ exec: vi.fn().mockRejectedValue(boom) });

    // The SAME error object, not a copy: nothing about a routine failure is touched.
    await expect(edgeContainerExecutor(inner, "openship-edge").exec("cat /x")).rejects.toBe(boom);
    expect(execCalls(inner)).toEqual(["docker exec 'openship-edge' sh -c 'cat /x'"]);
  });

  it("still explains itself when the diagnosis probes also fail", async () => {
    // Same dead SSH connection that broke the exec can break the probes. A partial
    // answer — the NAME — still beats a 64-hex id, and the probe failing must not
    // replace the real failure with an error about diagnosing it.
    const inner = fakeExecutor({
      exec: vi.fn(async (cmd: string) => {
        if (cmd.startsWith("docker ")) throw new Error(cmd.includes("exec") ? RESTARTING : "ssh: connection closed");
        return "";
      }),
    });

    await expect(edgeContainerExecutor(inner, "openship-edge").exec("openresty -t")).rejects.toThrow(
      /the edge container is not running \("openship-edge"\) — .*docker logs --tail 40 openship-edge/,
    );
  });

  // streamExec REPORTS failure instead of throwing it, and its callers build the error
  // they raise out of what was STREAMED (`_execCertbot` accumulates onLog lines and
  // throws that text). Appending to the return value alone would leave certbot's caller
  // raising the daemon's bare container id — i.e. the original bug, untouched.
  it("routes the explanation through onLog so a streaming caller's error carries it", async () => {
    const inner = fakeExecutor({
      exec: vi.fn(async (cmd: string) =>
        cmd.startsWith("docker inspect") ? "restarting\n" : CRASH_LOG,
      ),
      streamExec: vi.fn(async (_cmd: string, onLog: (l: LogEntry) => void) => {
        onLog(logEntry(RESTARTING, "error"));
        return { code: 1, output: RESTARTING };
      }),
    });

    // Exactly how `_execCertbot` builds the error it throws.
    let streamed = "";
    const result = await edgeContainerExecutor(inner, "openship-edge").streamExec(
      "certbot certonly --standalone",
      (log) => {
        streamed += log.message;
      },
    );

    expect(streamed).toMatch(/the edge container is not running \("openship-edge"\)/);
    expect(streamed).toMatch(/cannot load certificate/);
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/the edge container is not running/);
  });

  it("leaves a streamed certbot failure that is NOT the edge alone", async () => {
    // A real DNS failure must keep certbot's own diagnosis, and must not be
    // reframed as "the edge is down" — the operator would go fix the wrong thing.
    const dns = "Detail: DNS problem: NXDOMAIN looking up A for test.hekai.org";
    const inner = fakeExecutor({
      streamExec: vi.fn(async (_cmd: string, onLog: (l: LogEntry) => void) => {
        onLog(logEntry(dns, "error"));
        return { code: 1, output: dns };
      }),
    });

    const result = await edgeContainerExecutor(inner, "openship-edge").streamExec("certbot", () => {});
    expect(result).toEqual({ code: 1, output: dns });
    expect(execCalls(inner)).toEqual([]); // no diagnosis round-trips either
  });

  // `openresty -s reload` printing `invalid PID number ""` arrives immediately after
  // "test is successful", so it reads like a config problem. It isn't: openresty is
  // PID 1 in the container, so an empty pid file means the master is already gone.
  it("diagnoses an empty pid file as the edge being gone, not a bad config", async () => {
    const emptyPid =
      `nginx: configuration file /usr/local/openresty/nginx/conf/nginx.conf test is successful\n` +
      `nginx: [error] invalid PID number "" in "/usr/local/openresty/nginx/logs/nginx.pid"`;
    const inner = fakeExecutor({
      exec: vi.fn(async (cmd: string) => {
        if (cmd.startsWith("docker inspect")) return "restarting\n";
        if (cmd.startsWith("docker logs")) return CRASH_LOG;
        throw new Error(emptyPid);
      }),
    });

    await expect(edgeContainerExecutor(inner, "openship-edge").exec("openresty -s reload")).rejects.toThrow(
      /the edge container is not running.*cannot load certificate/s,
    );
  });
});

// The FOREIGN-proxy door: cert/config readers during import + migrate pass a
// container name they were handed (nginx/caddy/traefik), not our edge. Same rule,
// same function — these pin that the two doors can't drift apart.
describe("readMaybeInContainer (a named, foreign container)", () => {
  it("falls back into that container, not into ours", async () => {
    const exec = fakeExecutor({
      readFile: vi.fn(async () => ""),
      exec: vi.fn(async () => "cert-from-caddy"),
    });
    expect(await readMaybeInContainer(exec, "/data/caddy/x.crt", "caddy")).toBe("cert-from-caddy");
    expect(execCalls(exec)).toEqual([`docker exec 'caddy' sh -c 'cat '\\''/data/caddy/x.crt'\\'''`]);
  });

  it("prefers the host and never runs docker when the host answers", async () => {
    const exec = fakeExecutor({ readFile: vi.fn(async () => "cert-on-host") });
    expect(await readMaybeInContainer(exec, "/etc/ssl/x.crt", "caddy")).toBe("cert-on-host");
    expect(execCalls(exec)).toEqual([]);
  });

  it("is a plain host read with no container (absent or null)", async () => {
    const noArg = fakeExecutor({ readFile: vi.fn(async () => "") });
    expect(await readMaybeInContainer(noArg, "/etc/ssl/x.crt")).toBe("");
    expect(execCalls(noArg)).toEqual([]);
    const nulled = fakeExecutor({ readFile: vi.fn(async () => "") });
    expect(await readMaybeInContainer(nulled, "/etc/ssl/x.crt", null)).toBe("");
    expect(execCalls(nulled)).toEqual([]);
  });
});

describe("readEdgeFile", () => {
  it("uses the host copy when it's there, never reaching into the container", async () => {
    const inner = fakeExecutor({ readFile: vi.fn(async () => "host-pem") });
    expect(await readEdgeFile(inner, "/etc/letsencrypt/live/a/fullchain.pem")).toBe("host-pem");
    // `docker ps` (memoized per box) is fine; a `docker exec … cat` is not — that
    // would mean the host answer didn't win.
    expect(execCalls(inner).some((c) => c.includes("docker exec"))).toBe(false);
  });

  it("falls back into the edge container when the host read is empty", async () => {
    // Legacy install: certs sit in a named volume, so the host read returns "" and
    // the caller would silently re-issue via ACME instead of reusing the cert.
    const inner = fakeExecutor({
      readFile: vi.fn(async () => ""),
      exec: vi.fn(async (cmd: string) =>
        cmd.startsWith("docker ps") ? "openship-edge" : "volume-pem",
      ),
    });
    expect(await readEdgeFile(inner, "/etc/letsencrypt/live/a/fullchain.pem")).toBe("volume-pem");
  });

  it('returns "" rather than throwing when nothing can be read', async () => {
    const inner = fakeExecutor({
      readFile: vi.fn().mockRejectedValue(new Error("no such file")),
      exec: vi.fn().mockRejectedValue(new Error("ssh timeout")),
    });
    expect(await readEdgeFile(inner, "/etc/letsencrypt/live/a/fullchain.pem")).toBe("");
  });
});

describe("writeEdgeFile", () => {
  it("writes to the host and stops there when the edge already sees it", async () => {
    const inner = fakeExecutor({
      exec: vi.fn(async (cmd: string) => {
        if (cmd.startsWith("docker ps")) return "openship-edge";
        if (cmd.includes("test -e")) return "visible";
        return "";
      }),
    });
    await writeEdgeFile(inner, "/etc/letsencrypt/live/a/fullchain.pem", "pem");

    expect(inner.writeFile).toHaveBeenCalledWith("/etc/letsencrypt/live/a/fullchain.pem", "pem");
    expect(execCalls(inner).some((c) => c.startsWith("docker cp"))).toBe(false);
  });

  it("copies into the container when the host path isn't visible to the edge", async () => {
    // A named-volume install: the host write lands somewhere the edge never reads,
    // which is how migrated certs went missing and every kept domain re-issued.
    const inner = fakeExecutor({
      exec: vi.fn(async (cmd: string) => (cmd.startsWith("docker ps") ? "openship-edge" : "")),
    });
    await writeEdgeFile(inner, "/etc/letsencrypt/live/a/fullchain.pem", "pem");

    const cp = execCalls(inner).find((c) => c.startsWith("docker cp"));
    expect(cp).toBe(
      "docker cp '/etc/letsencrypt/live/a/fullchain.pem' 'openship-edge:/etc/letsencrypt/live/a/fullchain.pem'",
    );
  });

  it("is a plain host write when there's no edge container", async () => {
    const inner = fakeExecutor();
    await writeEdgeFile(inner, "/etc/letsencrypt/live/a/privkey.pem", "key");

    expect(inner.writeFile).toHaveBeenCalledWith("/etc/letsencrypt/live/a/privkey.pem", "key");
    expect(execCalls(inner).some((c) => c.startsWith("docker cp"))).toBe(false);
  });
});
