import { beforeEach, describe, expect, it, vi } from "vitest";

import { DockerRuntime, type DockerConnectionOptions } from "./docker";

/**
 * A REMOTE pull shells out on the target host, so it reads that host's credentials — which
 * is why a private image only worked if the operator had run `docker login` on every
 * server by hand (#581). It now gets a throwaway `DOCKER_CONFIG` for the one command.
 *
 * The properties pinned here are the security ones, because they are the reason this is
 * done with a file rather than the obvious `docker login`:
 *   - the secret is written with `writeFile`, NEVER as a command argument (argv is visible
 *     in `ps` to every user on that box for the life of the command);
 *   - the directory is 0700 and the file 0600;
 *   - the config is removed even when the pull fails or times out;
 *   - a host with no Openship credential keeps its existing behaviour exactly.
 */

const h = vi.hoisted(() => ({
  execs: [] as string[],
  writes: [] as { path: string; content: string }[],
  failPull: false,
}));

/** Minimal executor: records what it was asked to do. */
const executor = {
  exec: vi.fn(async (command: string) => {
    h.execs.push(command);
    if (h.failPull && command.includes("docker pull")) throw new Error("pull exploded");
    return "";
  }),
  streamExec: vi.fn(async () => ({ code: 0, output: "" })),
  writeFile: vi.fn(async (path: string, content: string) => {
    h.writes.push({ path, content });
  }),
  readFile: vi.fn(async () => ""),
};

const SECRET = "pat_super_secret_value";

async function runtimeWith(resolveRegistryAuth?: DockerConnectionOptions["resolveRegistryAuth"]) {
  const rt = await DockerRuntime.create({
    transport: "ssh",
    host: "example.com",
    // The transport insists on one auth method; the executor is what actually runs the
    // commands under test, so this only has to satisfy the constructor.
    password: "unused-by-this-test",
    executor,
    resolveRegistryAuth,
  } as unknown as DockerConnectionOptions);
  return rt;
}

/**
 * `force: true` throughout: it skips `pullImage`'s "already present" inspect, which is the
 * only part that would reach a real daemon. The pull path under test is identical.
 */

/** Every string this pull handed to a shell. */
const allCommands = () => h.execs.join("\n");

beforeEach(() => {
  h.execs = [];
  h.writes = [];
  h.failPull = false;
  vi.clearAllMocks();
});

describe("remote pull — no Openship credential", () => {
  it("pulls exactly as before, writing no config", async () => {
    await (await (await runtimeWith(undefined))).pullImage("ghcr.io/o/img:1", { force: true });
    expect(h.execs).toEqual(["docker pull 'ghcr.io/o/img:1'"]);
    expect(h.writes).toHaveLength(0);
  });

  it("pulls plainly when the resolver returns nothing for this registry", async () => {
    await (await runtimeWith(async () => undefined)).pullImage("postgres:16-alpine", { force: true });
    expect(allCommands()).toContain("docker pull 'postgres:16-alpine'");
    expect(allCommands()).not.toContain("DOCKER_CONFIG");
    expect(h.writes).toHaveLength(0);
  });

  it("pulls plainly when the credential is missing half the pair", async () => {
    // No serveraddress ⇒ nothing to file the credential under.
    await (await runtimeWith(async () => ({ username: "bob", password: SECRET }))).pullImage("ghcr.io/o/i", { force: true });
    expect(allCommands()).not.toContain("DOCKER_CONFIG");
    expect(allCommands()).not.toContain(SECRET);
  });
});

describe("remote pull — with an Openship credential", () => {
  const auth = async () => ({ username: "bob", password: SECRET, serveraddress: "ghcr.io" });

  it("never puts the secret in a command argument", async () => {
    // THE invariant: argv is world-readable via `ps` on that host.
    await (await (await runtimeWith(auth))).pullImage("ghcr.io/o/img:1", { force: true });
    expect(allCommands()).not.toContain(SECRET);
    expect(allCommands()).not.toContain(Buffer.from(`bob:${SECRET}`).toString("base64"));
  });

  it("delivers it as a 0600 config.json in a 0700 directory", async () => {
    await (await (await runtimeWith(auth))).pullImage("ghcr.io/o/img:1", { force: true });

    expect(h.writes).toHaveLength(1);
    const write = h.writes[0]!;
    expect(write.path).toMatch(/^\/tmp\/openship-pull-[0-9a-f-]+\/config\.json$/);
    // Keyed by the registry, and carrying only that one — not every credential the org has.
    const parsed = JSON.parse(write.content) as { auths: Record<string, { auth: string }> };
    expect(Object.keys(parsed.auths)).toEqual(["ghcr.io"]);
    expect(Buffer.from(parsed.auths["ghcr.io"]!.auth, "base64").toString()).toBe(`bob:${SECRET}`);

    // `mkdir -m 700`, not `mkdir -p` + chmod: the mode is set at creation (no
    // world-readable window) and an existing path is an ERROR, so this can never write
    // into a directory something else prepared.
    expect(allCommands()).toMatch(/^mkdir -m 700 '\/tmp\/openship-pull-[^']+'$/m);
    expect(allCommands()).not.toContain("mkdir -p");
    expect(allCommands()).toMatch(/chmod 600 '\/tmp\/openship-pull-[^']+'\/config\.json/);
  });

  it("points the pull at that config and cleans up on the command's own exit path", async () => {
    await (await (await runtimeWith(auth))).pullImage("ghcr.io/o/img:1", { force: true });
    const pull = h.execs.find((c) => c.includes("docker pull"))!;
    expect(pull).toMatch(/^DOCKER_CONFIG='\/tmp\/openship-pull-[^']+' docker pull 'ghcr\.io\/o\/img:1'/);
    // rc is captured BEFORE the cleanup so a failed pull still reports its own status.
    expect(pull).toContain("rc=$?; rm -rf ");
    expect(pull).toContain("exit $rc");
  });

  it("removes the config even when the pull fails", async () => {
    // The finally exists for the case the exec never reaches its own `rm` — a timeout kill.
    h.failPull = true;
    await expect((await (await runtimeWith(auth))).pullImage("ghcr.io/o/img:1", { force: true })).rejects.toThrow(/pull exploded/);
    const cleanups = h.execs.filter((c) => c.startsWith("rm -rf "));
    expect(cleanups).toHaveLength(1);
    expect(cleanups[0]).toMatch(/^rm -rf '\/tmp\/openship-pull-[^']+'$/);
  });

  it("uses a fresh directory per pull", async () => {
    const rt = await runtimeWith(auth);
    await rt.pullImage("ghcr.io/o/a:1", { force: true });
    await rt.pullImage("ghcr.io/o/b:1", { force: true });
    const dirs = new Set(h.writes.map((w) => w.path));
    expect(dirs.size).toBe(2);
  });

  it("supports an identity token instead of a password", async () => {
    await (await runtimeWith(async () => ({
      identitytoken: SECRET,
      serveraddress: "ghcr.io",
    }))).pullImage("ghcr.io/o/i", { force: true });
    const parsed = JSON.parse(h.writes[0]!.content) as {
      auths: Record<string, { identitytoken: string }>;
    };
    expect(parsed.auths["ghcr.io"]!.identitytoken).toBe(SECRET);
    expect(allCommands()).not.toContain(SECRET);
  });
});
