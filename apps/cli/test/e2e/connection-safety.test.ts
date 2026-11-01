import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { projectFixture, systemInfoFixture } from "../../../../packages/contracts/test/fixtures";
import type { CliConfig } from "../../src/lib/config";
import { SDK_CAPABILITIES } from "@repo/contracts";

const root = resolve(import.meta.dirname, "../..");
const loader = createRequire(join(root, "package.json")).resolve("tsx");
const inject = pathToFileURL(join(root, "test/helpers/inject-version.mjs")).href;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

interface Request {
  target: string;
  url: URL;
  method: string;
  authorization?: string;
  organization?: string;
  body: any;
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "openship-cli-connection-"));
  const state = join(directory, "state");
  const project = join(directory, "project");
  await mkdir(state);
  await mkdir(join(project, ".openship"), { recursive: true });
  await writeFile(join(project, "index.html"), "fixture");
  const servers: Server[] = [];
  const requests: Request[] = [];
  let onRequest: ((request: Request) => Promise<void>) | undefined;
  const config: CliConfig = { current: "first", contexts: {} };
  const save = () => writeFile(join(state, "config.json"), JSON.stringify(config));
  cleanup.push(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
    }
    await rm(directory, { recursive: true, force: true });
  });
  for (const target of ["first", "second"]) {
    const server = createServer(async (req: IncomingMessage, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const text = Buffer.concat(chunks).toString();
        const request: Request = {
          target, url: new URL(req.url!, config.contexts[target].apiUrl), method: req.method!,
          authorization: req.headers.authorization,
          organization: req.headers["x-organization-id"] as string | undefined,
          body: req.headers["content-type"]?.includes("application/json") && text ? JSON.parse(text) : undefined,
        };
        requests.push(request);
        await onRequest?.(request);
        const path = request.url.pathname;
        let data: unknown;
        if (path === "/api/projects") {
          const page = Number(request.url.searchParams.get("page") ?? 1);
          data = { data: page === 1 ? Array.from({ length: 50 }, (_, i) => projectFixture(`proj_${i}`)) : [projectFixture("proj_last")], page, perPage: 50, total: 51 };
        } else if (path === "/api/health") data = { sdk: SDK_CAPABILITIES };
        else if (path === "/api/health/env") data = systemInfoFixture();
        else if (path === "/api/tokens") data = { data: [] };
        else if (path === "/api/deployments") data = { data: { deployment_id: "dep_fixture", project_id: request.body.projectId } };
        else if (path === "/api/deployments/dep_fixture/stream") {
          res.setHeader("Content-Type", "text/event-stream");
          res.end('event: end\ndata: {"status":"ready"}\n\n');
          return;
        } else if (path === "/api/deployments/dep_fixture/build") {
          data = { success: true, deployment_id: "dep_fixture", project_id: "proj_fixture", status: "ready", is_active: true,
            deploymentStatus: "ready", completionPending: false, decisionPending: false, cancellationPending: false, pendingPrompt: null };
        } else if (path === "/api/projects/folder/session") {
          data = { sessionId: "upload", expiresAt: Date.now() + 60_000,
            upload: { url: "projects/folder/upload/upload", absoluteUrl: request.url.origin + "/api/projects/folder/upload/upload", method: "POST", headers: {}, requiresAuth: true, withCredentials: true } };
        } else if (path === "/api/projects/folder/upload/upload") data = { success: true };
        else if (path === "/api/projects/folder/scan/upload") {
          data = { success: true, name: "fixture", stack: "static", projectType: "app", packageManager: "npm", installCommand: "", buildCommand: "", startCommand: "", buildImage: "", outputDirectory: "", rootDirectory: "" };
        } else if (path === "/api/projects/ensure") data = { success: true, project_id: "proj_fixture", created: false };
        else if (path === "/api/deployments/build/access") data = { success: true, deployment_id: "dep_fixture", project_id: "proj_fixture" };
        else if (path === "/api/system/data-transfer/import") data = { mode: request.body.mode, rowsRestored: 0, secretsRehydrated: 0, secretsSkipped: false };
        else { res.statusCode = 404; data = { error: `Unexpected fixture path: ${path}` }; }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(data));
      } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })); }
    });
    servers.push(server);
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    config.contexts[target] = { apiUrl, dashboardUrl: apiUrl, token: `opsh_pat_${target}_fixture_only` };
  }
  await save();
  const link = (patch: Record<string, unknown> = {}) => writeFile(join(project, ".openship/project.json"), JSON.stringify({
    projectId: "proj_fixture", context: "first", apiUrl: config.contexts.first.apiUrl + "/api",
    defaults: { environment: "preview" }, ...patch,
  }));
  const run = (args: string[], environment: NodeJS.ProcessEnv = {}) => new Promise<{ code: number; out: string; err: string }>(done => {
    execFile(process.execPath, ["--import", loader, "--import", inject, join(root, "src/index.ts"), "--json", ...args], {
      cwd: project, env: { ...process.env, OPENSHIP_HOME: state, OPENSHIP_JSON: "1",
        OPENSHIP_CONTEXT: undefined, OPENSHIP_API_URL: undefined, OPENSHIP_TOKEN: undefined,
        OPENSHIP_ORGANIZATION_ID: undefined, ...environment },
      timeout: 15_000, maxBuffer: 2 * 1024 * 1024,
    }, (error, out, err) => done({ code: error ? typeof error.code === "number" ? error.code : 1 : 0, out, err }));
  });
  return { directory, project, config, requests, save, link, run,
    onRequest: (hook: typeof onRequest) => { onRequest = hook; } };
}

describe("assembled CLI connection and input safety", { timeout: 30_000 }, () => {
  it("removes only the stored token and reports an active environment token honestly", async () => {
    const f = await fixture();
    const result = await f.run(["logout"], { OPENSHIP_TOKEN: "opsh_pat_environment_fixture" });
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ authenticated: true, context: "first", removed: true, credentialSource: "environment" });
    const saved = JSON.parse(await readFile(join(f.directory, "state/config.json"), "utf8"));
    expect(saved.contexts.first.token).toBeUndefined();
    expect(saved.contexts.second.token).toBe(f.config.contexts.second.token);
    expect(result.out + result.err).not.toContain("opsh_pat_environment_fixture");
    expect(f.requests).toEqual([]);
  });

  it("refuses project deletion in automation without confirmation and sends no write", async () => {
    const f = await fixture();
    const result = await f.run(["project", "delete", "proj_fixture"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("--yes");
    expect(f.requests).toEqual([]);
  });

  it("reads a login token from a private file and does not print it", async () => {
    const f = await fixture();
    const file = join(f.directory, "token");
    await writeFile(file, "opsh_pat_file_fixture\n", { mode: 0o600 });
    const result = await f.run(["login", "--context", "first", "--token-file", file]);
    expect(result.code, result.err).toBe(0);
    expect(f.requests.find(req => req.url.pathname === "/api/tokens")?.authorization).toBe("Bearer opsh_pat_file_fixture");
    expect(result.out + result.err).not.toContain("opsh_pat_file_fixture");
    const saved = JSON.parse(await readFile(join(f.directory, "state/config.json"), "utf8"));
    expect(saved.contexts.first.token).toBe("opsh_pat_file_fixture");
  });

  it("selects a context for one invocation without changing the saved default", async () => {
    const f = await fixture();
    const result = await f.run(["--context", "second", "project", "list"]);
    expect(result.code, result.err).toBe(0);
    expect(f.requests).toHaveLength(2);
    expect(f.requests.every(req => req.target === "second" && req.authorization === "Bearer opsh_pat_second_fixture_only")).toBe(true);
    expect(JSON.parse(await readFile(join(f.directory, "state/config.json"), "utf8")).current).toBe("first");
  });

  it("rejects an unknown invocation context before contacting any API", async () => {
    const f = await fixture();
    const result = await f.run(["--context", "missing", "project", "list"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('Unknown context "missing"');
    expect(f.requests).toEqual([]);
  });

  it("lets an explicit context override the entire ambient CI connection", async () => {
    const f = await fixture();
    const result = await f.run(["--context", "second", "project", "list"], {
      OPENSHIP_API_URL: f.config.contexts.first.apiUrl,
      OPENSHIP_TOKEN: "opsh_pat_ambient_fixture",
      OPENSHIP_ORGANIZATION_ID: "org-ambient",
    });
    expect(result.code, result.err).toBe(0);
    expect(f.requests).toHaveLength(2);
    expect(f.requests.every(req => req.target === "second" && req.authorization === "Bearer opsh_pat_second_fixture_only" && req.organization === undefined)).toBe(true);
  });

  it("uses an ephemeral CI connection and tenant without storing the token", async () => {
    const f = await fixture();
    const result = await f.run(["project", "list"], {
      OPENSHIP_API_URL: f.config.contexts.second.apiUrl,
      OPENSHIP_TOKEN: "opsh_pat_ephemeral_fixture",
      OPENSHIP_ORGANIZATION_ID: "org-ci",
    });
    expect(result.code, result.err).toBe(0);
    const calls = f.requests.filter(req => req.url.pathname === "/api/projects");
    expect(calls).toHaveLength(2);
    expect(calls.every(req => req.target === "second" && req.authorization === "Bearer opsh_pat_ephemeral_fixture" && req.organization === "org-ci")).toBe(true);
    const saved = await readFile(join(f.directory, "state/config.json"), "utf8");
    expect(saved + result.out + result.err).not.toContain("opsh_pat_ephemeral_fixture");
    expect(JSON.parse(saved)).toEqual(f.config);
  });

  it("never reuses a saved token when only the invocation API is retargeted", async () => {
    const f = await fixture();
    const result = await f.run(["project", "list"], { OPENSHIP_API_URL: f.config.contexts.second.apiUrl });
    expect(result.code, result.err).toBe(0);
    expect(f.requests).toHaveLength(2);
    expect(f.requests.every(req => req.target === "second" && req.authorization === undefined)).toBe(true);
  });

  it("uses the saved organization and permits an explicit per-command override", async () => {
    const f = await fixture();
    f.config.contexts.second.organizationId = "org-saved";
    await f.save();
    expect((await f.run(["--context", "second", "project", "list"])).code).toBe(0);
    expect(f.requests.filter(req => req.url.pathname === "/api/projects").every(req => req.organization === "org-saved")).toBe(true);
    f.requests.length = 0;
    expect((await f.run(["--context", "second", "--organization", "org-other", "project", "list"])).code).toBe(0);
    expect(f.requests.filter(req => req.url.pathname === "/api/projects").every(req => req.organization === "org-other")).toBe(true);
  });

  it("drops saved authority when a context's API is changed without replacement credentials", async () => {
    const f = await fixture();
    f.config.contexts.first.organizationId = "org-old";
    await f.save();
    const result = await f.run(["context", "add", "first", "--api-url", f.config.contexts.second.apiUrl!]);
    expect(result.code, result.err).toBe(0);
    const saved = JSON.parse(await readFile(join(f.directory, "state/config.json"), "utf8"));
    expect(saved.contexts.first.token).toBeUndefined();
    expect(saved.contexts.first.organizationId).toBeUndefined();
    expect(saved.current).toBe("first");
  });

  it("keeps API and token together across pagination, then uses the new context on the next invocation", async () => {
    const f = await fixture();
    f.onRequest(async req => {
      if (req.url.searchParams.get("page") === "1") { f.config.current = "second"; await f.save(); }
    });
    const result = await f.run(["project", "list"]);
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out)).toHaveLength(51);
    expect(f.requests.map(req => [req.target, req.authorization])).toEqual([
      ["first", "Bearer opsh_pat_first_fixture_only"], ["first", "Bearer opsh_pat_first_fixture_only"],
    ]);
    f.requests.length = 0;
    expect((await f.run(["project", "list"])).code).toBe(0);
    expect(f.requests.every(req => req.target === "second" && req.authorization === "Bearer opsh_pat_second_fixture_only")).toBe(true);
  });

  it.each([false, true])("pins separate clients through deployment, upload and watch (folder=%s)", async folder => {
    const f = await fixture();
    f.onRequest(async () => {
      f.config.current = "second";
      // Even a retarget of the original named context cannot change this invocation.
      f.config.contexts.first = { ...f.config.contexts.second };
      await f.save();
    });
    const result = await f.run(["deploy", "--project", "proj_fixture", ...(folder ? ["--folder"] : ["--branch", "main"]), "--watch"]);
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain('"event":"outcome"');
    expect(f.requests.every(req => req.target === "first" && req.authorization === "Bearer opsh_pat_first_fixture_only")).toBe(true);
    expect(f.requests.at(-1)?.url.pathname).toBe("/api/deployments/dep_fixture/build");
    if (folder) expect(f.requests.some(req => req.url.pathname === "/api/projects/folder/upload/upload")).toBe(true);
  });

  it("rejects a different linked context before requests, but allows deliberate --project selection", async () => {
    const f = await fixture();
    await f.link(); f.config.current = "second"; await f.save();
    const rejected = await f.run(["deploy", "--branch", "main"]);
    expect(rejected.code).toBe(1);
    expect(rejected.err).toContain("different connection");
    expect(f.requests).toEqual([]);
    const explicit = await f.run(["deploy", "--project", "proj_other", "--branch", "main"]);
    expect(explicit.code, explicit.err).toBe(0);
    expect(f.requests[0]).toMatchObject({ target: "second", body: { projectId: "proj_other", environment: "production" } });
  });

  it("detects a named context whose endpoint was changed after linking", async () => {
    const f = await fixture();
    await f.link(); f.config.contexts.first = f.config.contexts.second; await f.save();
    const result = await f.run(["deploy", "--branch", "main"]);
    expect(result.code).toBe(1);
    expect(f.requests).toEqual([]);
  });

  it("sends an explicit fixed organization scope and protects links made for another scope", async () => {
    const f = await fixture();
    const result = await f.run(["--organization", "org-a", "project", "list"]);
    expect(result.code, result.err).toBe(0);
    const resourceRequests = f.requests.filter(req => req.url.pathname === "/api/projects");
    expect(resourceRequests).toHaveLength(2);
    expect(resourceRequests.every(req => req.organization === "org-a")).toBe(true);
    await f.link({ organizationId: "org-a" }); f.requests.length = 0;
    expect((await f.run(["--organization", "org-b", "deploy", "--branch", "main"])).code).toBe(1);
    expect(f.requests).toEqual([]);
  });

  it("honors the linked variable set, explicit overrides, and validates saved defaults", async () => {
    const f = await fixture(); await f.link();
    expect((await f.run(["deploy", "--branch", "main"])).code).toBe(0);
    expect(f.requests.at(-1)?.body.environment).toBe("preview");
    expect((await f.run(["deploy", "--branch", "main", "--env", "production"])).code).toBe(0);
    expect(f.requests.at(-1)?.body.environment).toBe("production");
    await f.link({ defaults: { environment: "typo" } }); f.requests.length = 0;
    expect((await f.run(["deploy", "--branch", "main"])).code).toBe(1);
    expect(f.requests).toEqual([]);
  });

  it("refreshes capabilities on the newly authenticated endpoint and emits secret-free JSON", async () => {
    const f = await fixture();
    const result = await f.run(["login", "--token", "opsh_pat_login_fixture", "--context", "new", "--api-url", f.config.contexts.second.apiUrl!]);
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ authenticated: true, context: "new" });
    expect(result.out + result.err).not.toContain("opsh_pat_login_fixture");
    expect(f.requests.map(req => [req.target, req.url.pathname])).toEqual([["second", "/api/tokens"], ["second", "/api/health/env"]]);
  });

  it("rejects import typos without requests, and preserves merge/wipe confirmation semantics", async () => {
    const f = await fixture();
    const file = join(f.directory, "export.json"); await writeFile(file, JSON.stringify({ kind: "openship-instance-export", envelopeVersion: 4, createdAt: "2026-10-07", sourceDriver: "pglite", dump: { tables: {} }, secrets: null }));
    const args = ["system", "data-transfer", "import", "--file", file];
    expect((await f.run([...args, "--mode", "merg", "--yes"])).code).toBe(1);
    expect(f.requests).toEqual([]);
    expect((await f.run(args)).code).toBe(1);
    expect(f.requests.some(req => req.url.pathname.endsWith("/import"))).toBe(false);
    for (const flags of [["--mode", "merge"], ["--mode", "wipe", "--yes"], ["--yes"]]) {
      const result = await f.run([...args, ...flags]);
      expect(result.code, result.err).toBe(0);
      expect(f.requests.at(-1)?.body.mode).toBe(flags[1] === "merge" ? "merge" : "wipe");
    }
  });

  it("init records the selected API and refuses interactive selection in JSON mode", async () => {
    const f = await fixture();
    expect((await f.run(["init"])).code).toBe(1);
    expect(f.requests).toEqual([]);
    expect((await f.run(["init", "--project", "proj_fixture", "--environment", "preview"])).code).toBe(0);
    expect(JSON.parse(await readFile(join(f.project, ".openship/project.json"), "utf8"))).toMatchObject({
      context: "first", apiUrl: f.config.contexts.first.apiUrl + "/api", defaults: { environment: "preview" },
    });
  });
});
