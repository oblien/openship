import { execFile, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const cliRoot = resolve(import.meta.dirname, "../..");
const entry = join(cliRoot, "src/index.ts");
const inject = pathToFileURL(join(cliRoot, "test/helpers/inject-version.mjs")).href;
const execute = promisify(execFile);
const temporary: string[] = [];

beforeAll(async () => {
  await execute("bun", ["run", "build:native"], { cwd: resolve(cliRoot, "../../packages/platform"), maxBuffer: 2 * 1024 * 1024 });
}, 60_000);
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "openship-native-cli-"));
  temporary.push(directory);
  const guard = join(directory, "no-http.mjs");
  await writeFile(guard, "globalThis.fetch = async () => { throw new Error('unexpected CLI HTTP request'); };\n");
  const config = async (name = "native", scopeCode = "") => {
    const file = join(directory, `${name}.mjs`);
    await writeFile(file, `
let identity = null;
export default {
  options: {
    instanceId: 'cli-test', stateDirectory: ${JSON.stringify(directory)},
    storage: { driver: 'pglite', dataDir: ${JSON.stringify(join(directory, "database"))} },
    encryptionKey: 'native-cli-test-persistent-key-at-least-32-bytes',
    runtime: 'bare', routing: 'none', administration: true,
    identity: { resolve: async assertion => assertion === 'cli' ? identity : null }
  },
  async scope(ship) {
    const mapped = await ship.operator.ensureIdentity({ issuer: 'cli', subject: 'alice', email: 'alice@example.test', instanceAdmin: true });
    identity = { user: mapped.user, sessionId: 'cli-session' };
    ${scopeCode}
    return { identity: 'cli', organizationId: mapped.personalOrganizationId };
  }
};\n`);
    return file;
  };
  const run = (args: string[], onChild?: (child: ChildProcess) => void) => new Promise<{ code: number; stdout: string; stderr: string }>(done => {
    const child = execFile(process.execPath, ["--import", "tsx", "--import", inject, "--import", pathToFileURL(guard).href, entry, ...args],
      { cwd: cliRoot, timeout: 45_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
        const code = error ? typeof error.code === "number" ? error.code : 1 : 0;
        done({ code, stdout, stderr });
      });
    onChild?.(child);
  });
  return { directory, config, run };
}

describe("native CLI through a real Node worker and PGlite", { timeout: 120_000 }, () => {
  it("creates and reopens projects with clean JSON and no HTTP connection", async () => {
    const f = await fixture();
    const config = await f.config();
    const flags = ["--native-config", config, "--json"];
    const created = await f.run([...flags, "project", "create", "--name", "CLI Project"]);
    expect(created.code, created.stderr).toBe(0);
    const project = JSON.parse(created.stdout);
    expect(project).toMatchObject({ name: "CLI Project" });
    const listed = await f.run([...flags, "project", "list"]);
    expect(listed.code, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual(expect.arrayContaining([expect.objectContaining({ id: project.id })]));
    const status = await f.run([...flags, "status"]);
    expect(status.code, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ mode: "native", instanceId: "cli-test", organizationId: project.organizationId });
    const health = await f.run([...flags, "doctor"]);
    expect(health.code, health.stderr).toBe(0);
    expect(JSON.parse(health.stdout)).toMatchObject({ mode: "native", ok: true, db: { driver: "pglite", ok: true } });
  });

  it("drains the worker after failed operations and early command exits", async () => {
    const f = await fixture();
    const config = await f.config();
    const flags = ["--native-config", config, "--json"];
    const missing = await f.run([...flags, "project", "get", "missing-project"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr.toLowerCase()).toContain("not found");
    const invalid = await f.run([...flags, "deploy", "--env", "invalid"]);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("Invalid --env");
    expect(invalid.stderr).not.toContain("Command exited");
    const reopened = await f.run([...flags, "project", "list"]);
    expect(reopened.code, reopened.stderr).toBe(0);
    expect(JSON.parse(reopened.stdout)).toEqual([]);
  });

  it("uses native app installation and backup destination services across invocations", async () => {
    const f = await fixture();
    const config = await f.config();
    const flags = ["--native-config", config, "--json"];
    const definition = join(f.directory, "app.json");
    await writeFile(definition, JSON.stringify({
      id: "cli-app", name: "CLI App", description: "CLI integration fixture", kind: "template", logo: "box", category: "other",
      services: [{ name: "web", image: "nginx:1.27" }],
    }));
    const added = await f.run([...flags, "app", "custom", "add", definition]);
    expect(added.code, added.stderr).toBe(0);
    expect(JSON.parse(added.stdout)).toEqual({ appId: "cli-app" });
    const installed = await f.run([...flags, "app", "install", "cli-app"]);
    expect(installed.code, installed.stderr).toBe(0);
    expect(JSON.parse(installed.stdout)).toMatchObject({ kind: "template", projectId: expect.any(String) });
    const created = await f.run([...flags, "backup", "destination", "create", "--name", "Object backups", "--kind", "s3_compatible", "--bucket", "backups", "--access-key-id", "cli-access-key", "--secret-access-key", "cli-storage-secret"]);
    expect(created.code, created.stderr).toBe(0);
    const destination = JSON.parse(created.stdout);
    expect(destination).toMatchObject({ hasAccessKeyId: true, hasSecretAccessKey: true });
    expect(created.stdout).not.toContain("cli-storage-secret");
    const retrieved = await f.run([...flags, "backup", "destination", "get", destination.id]);
    expect(retrieved.code, retrieved.stderr).toBe(0);
    expect(JSON.parse(retrieved.stdout)).toEqual(destination);
  });

  it("closes an allocated instance if host scope resolution fails", async () => {
    const f = await fixture();
    const bad = await f.config("bad", "throw new Error('host scope failed');");
    const failed = await f.run(["--native-config", bad, "project", "list"]);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("host scope failed");
    const good = await f.config();
    const reopened = await f.run(["--native-config", good, "--json", "project", "list"]);
    expect(reopened.code, reopened.stderr).toBe(0);
    expect(JSON.parse(reopened.stdout)).toEqual([]);
  });

  it("does not load config for help/version and refuses invalid config without remote fallback", async () => {
    const f = await fixture();
    const missing = join(f.directory, "missing.mjs");
    expect((await f.run(["--native-config", missing, "--version"])).code).toBe(0);
    expect((await f.run(["--native-config", missing, "project", "--help"])).code).toBe(0);
    const failed = await f.run(["--native-config", missing, "project", "list"]);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("ENOENT");
    expect(failed.stderr).not.toContain("unexpected CLI HTTP request");
    const attached = join(f.directory, "attached.mjs");
    await writeFile(attached, "export default { options: { platform: {} }, scope: {} };\n");
    const refused = await f.run(["--native-config", attached, "project", "list"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("owned instance options");
    const installer = await f.run(["--native-config", missing, "up"]);
    expect(installer.code).toBe(1);
    expect(installer.stderr).toContain("Choose an SDK resource command");
  });

  it("pins project links to their native instance and organization", async () => {
    const f = await fixture();
    const config = await f.config();
    const linked = await f.run(["--native-config", config, "--json", "init", "--project", "project-a", "--dir", f.directory]);
    expect(linked.code, linked.stderr).toBe(0);
    const link = JSON.parse(await readFile(join(f.directory, ".openship/project.json"), "utf8"));
    expect(link.native).toMatchObject({ instanceId: "cli-test", organizationId: expect.any(String) });
    expect(link).not.toHaveProperty("context");
  });

  it("drains a worker when terminated during scope initialization", async () => {
    const f = await fixture();
    const delayed = await f.config("delayed", "console.error('CLI_SCOPE_READY'); await new Promise(resolve => setTimeout(resolve, 500));");
    let signalled = false;
    const stopped = await f.run(["--native-config", delayed, "project", "list"], child => {
      child.stderr?.on("data", data => {
        if (!signalled && String(data).includes("CLI_SCOPE_READY")) { signalled = true; child.kill("SIGTERM"); }
      });
    });
    expect(signalled).toBe(true);
    expect(stopped.code, stopped.stderr).toBe(143);
    const good = await f.config();
    const reopened = await f.run(["--native-config", good, "--json", "project", "list"]);
    expect(reopened.code, reopened.stderr).toBe(0);
  });
});
