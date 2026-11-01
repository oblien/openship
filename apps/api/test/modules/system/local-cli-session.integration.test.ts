import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const apiRoot = resolve(import.meta.dirname, "../../..");
const cliRoot = resolve(apiRoot, "../cli");
const loader = createRequire(join(cliRoot, "package.json")).resolve("tsx");
const inject = pathToFileURL(join(cliRoot, "test/helpers/inject-version.mjs")).href;
const internal = "local-cli-integration-fixture-secret";
let directory: string;
let child: ChildProcess;
let url: string;
let diagnostics = "";

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "openship-local-auth-integration-"));
  child = spawn(
    process.execPath,
    ["--import", loader, join(apiRoot, "test/fixtures/local-cli-server.ts")],
    {
      cwd: apiRoot,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "test",
        PGLITE_DATA_DIR: "memory://",
        OPENSHIP_HOME: directory,
        OPENSHIP_TARGET: "local",
        CLOUD_MODE: "false",
        DEPLOY_MODE: "bare",
        OPENSHIP_AUTH_MODE: "local",
        OPENSHIP_REQUIRE_AUTH: "true",
        OPENSHIP_HOST_CONTROL: "false",
        INTERNAL_TOKEN: internal,
        BETTER_AUTH_SECRET: "local-cli-integration-encryption-key-32-bytes",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  child.stdout!.on("data", (value) => {
    diagnostics += String(value);
  });
  child.stderr!.on("data", (value) => {
    diagnostics += String(value);
  });
  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Isolated auth server did not start: " + diagnostics)),
      45000,
    );
    child.once("message", (message: any) => {
      clearTimeout(timeout);
      resolve(message.port);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Auth fixture exited ${code}: ${diagnostics}`));
    });
  });
  url = `http://127.0.0.1:${port}`;
  await writeFile(join(directory, "internal-token"), internal, { mode: 0o600 });
  await writeFile(join(directory, "ports.json"), JSON.stringify({ api: port, dashboard: 3001 }));
}, 60000);

afterAll(async () => {
  if (child?.exitCode === null && child.signalCode === null) {
    const stopped = new Promise<void>((done) => child.once("exit", () => done()));
    child.kill("SIGTERM");
    const deadline = setTimeout(() => child.kill("SIGKILL"), 10000);
    await stopped;
    clearTimeout(deadline);
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

function run(args: string[]) {
  return new Promise<{ code: number; out: string; err: string }>((done) => {
    execFile(
      process.execPath,
      [
        "--import",
        loader,
        "--import",
        inject,
        join(cliRoot, "src/index.ts"),
        "--local",
        "--json",
        ...args,
      ],
      {
        cwd: directory,
        timeout: 20000,
        env: { PATH: process.env.PATH, OPENSHIP_HOME: directory },
      },
      (error, out, err) =>
        done({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, out, err }),
    );
  });
}
async function sessionCount() {
  return (
    await (
      await fetch(url + "/api/test-session-count", { headers: { "X-Internal-Token": internal } })
    ).json()
  ).count;
}

describe("local CLI through real HTTP, Better Auth and PGlite", () => {
  it("cannot read projects anonymously, then authenticates automatically and revokes its session", async () => {
    expect((await fetch(url + "/api/projects")).status).toBe(401);
    const result = await run(["project", "list"]);
    expect(result.code, result.err + diagnostics).toBe(0);
    expect(JSON.parse(result.out)).toEqual([]);
    expect(await sessionCount()).toBe(0);
  });

  it("uses the founder's existing membership and bearer session without a PAT", async () => {
    const result = await run(["api", "/test-authority"]);
    expect(result.code, result.err + diagnostics).toBe(0);
    expect(JSON.parse(result.out)).toEqual({
      userId: "cli-fixture-admin",
      organizationId: "org_cli-fixture-admin",
      sessionKind: "bearer",
      sessionId: expect.stringMatching(/^sess_cli_/),
    });
    expect(result.out + result.err).not.toContain(internal);
    expect(await sessionCount()).toBe(0);
  });

  it("refuses an unrelated organization without leaving a temporary session behind", async () => {
    const result = await run(["--organization", "org-other", "project", "list"]);
    expect(result.code).toBe(1);
    expect(await sessionCount()).toBe(0);
  });

  it("expires abandoned sessions and cleans them during the next local authentication", async () => {
    const response = await fetch(url + "/api/system/cli-session", {
      method: "POST",
      headers: { "X-Internal-Token": internal },
    });
    expect(response.status).toBe(200);
    const session = await response.json();
    expect(await sessionCount()).toBe(1);
    await fetch(url + "/api/test-expire-sessions", {
      method: "POST",
      headers: { "X-Internal-Token": internal },
    });
    expect(
      (
        await fetch(url + "/api/projects", {
          headers: { Authorization: `Bearer ${session.token}` },
        })
      ).status,
    ).toBe(401);
    const result = await run(["project", "list"]);
    expect(result.code, result.err + diagnostics).toBe(0);
    expect(await sessionCount()).toBe(0);
  });
});
