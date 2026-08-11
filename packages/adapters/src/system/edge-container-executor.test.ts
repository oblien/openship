import { describe, expect, it, vi, type Mock } from "vitest";

import {
  containerCommand,
  edgeContainerExecutor,
  readEdgeFile,
  readMaybeInContainer,
  writeEdgeFile,
} from "./edge-container-executor";
import type { CommandExecutor } from "../types";

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

    expect(inner.streamExec).toHaveBeenCalledWith(
      "docker exec 'openship-edge' sh -c 'certbot certonly'",
      onLog,
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
