import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SDK_CAPABILITIES } from "@repo/contracts";

const cliRoot = resolve(import.meta.dirname, "../..");
const loader = createRequire(join(cliRoot, "package.json")).resolve("tsx");
const inject = pathToFileURL(join(cliRoot, "test/helpers/inject-version.mjs")).href;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture(method: "bare" | "compose" = "bare") {
  const directory = await mkdtemp(join(tmpdir(), "openship-cli-local-"));
  const servers: Server[] = [];
  const requests: Array<{
    target: string;
    path: string;
    internal?: string;
    bearer?: string;
    organization?: string;
  }> = [];
  const control = {
    exchangeStatus: 200,
    resourceStatus: 200,
    redirect: "",
    invalidResponse: false,
  };
  const endpoints: Record<string, string> = {};
  const internal = "private-local-fixture-credential";
  const token = "a".repeat(64);
  for (const target of ["local", "remote"]) {
    const server = createServer((req, res) => {
      const path = new URL(req.url!, "http://fixture").pathname;
      requests.push({
        target,
        path,
        internal: req.headers["x-internal-token"] as string | undefined,
        bearer: req.headers.authorization,
        organization: req.headers["x-organization-id"] as string | undefined,
      });
      res.setHeader("Content-Type", "application/json");
      let body: unknown;
      if (path === "/api/system/cli-session") {
        if (control.redirect) {
          res.writeHead(307, { Location: control.redirect });
          res.end();
          return;
        }
        res.statusCode =
          req.headers["x-internal-token"] === internal ? control.exchangeStatus : 401;
        body =
          res.statusCode === 200
            ? control.invalidResponse
              ? { token: internal }
              : { token, expiresAt: new Date(Date.now() + 3600000).toISOString() }
            : { error: res.statusCode === 401 ? "Unauthorized" : internal };
      } else if (path === "/api/projects") {
        res.statusCode = control.resourceStatus;
        body =
          res.statusCode === 200
            ? { data: [], page: 1, perPage: 50, total: 0 }
            : { error: "Resource denied" };
      } else if (path === "/api/auth/sign-out") body = { success: true };
      else if (path === "/api/health") body = { sdk: SDK_CAPABILITIES };
      else {
        res.statusCode = 404;
        body = { error: "Unknown path" };
      }
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    servers.push(server);
    endpoints[target] = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }
  cleanup.push(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(
    join(directory, "ports.json"),
    JSON.stringify({ api: Number(new URL(endpoints.local).port), dashboard: 3123 }),
  );
  if (method === "bare")
    await writeFile(join(directory, "internal-token"), internal, { mode: 0o600 });
  else {
    await mkdir(join(directory, "compose"));
    await writeFile(join(directory, "compose/docker-compose.yml"), "services: {}\n");
    await writeFile(join(directory, "compose/.env"), `INTERNAL_TOKEN=${internal}\n`, {
      mode: 0o600,
    });
  }
  const configPath = join(directory, "config.json");
  const configure = (contexts: Record<string, unknown>, current = Object.keys(contexts)[0]) =>
    writeFile(configPath, JSON.stringify({ current, contexts }));
  const run = (args: string[] = ["project", "list"], environment: NodeJS.ProcessEnv = {}) =>
    new Promise<{ code: number; out: string; err: string }>((done) => {
      execFile(
        process.execPath,
        ["--import", loader, "--import", inject, join(cliRoot, "src/index.ts"), "--json", ...args],
        {
          cwd: directory,
          env: {
            ...process.env,
            OPENSHIP_HOME: directory,
            OPENSHIP_JSON: "1",
            OPENSHIP_CONTEXT: undefined,
            OPENSHIP_API_URL: undefined,
            OPENSHIP_TOKEN: undefined,
            OPENSHIP_ORGANIZATION_ID: undefined,
            ...environment,
          },
          timeout: 20_000,
        },
        (error, out, err) =>
          done({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, out, err }),
      );
    });
  return { directory, requests, endpoints, internal, token, run, control, configure, configPath };
}

describe("installed CLI local administrator connection", { timeout: 30_000 }, () => {
  it.each(["bare", "compose"] as const)(
    "authenticates the %s installation automatically on its stored port and signs out",
    async (method) => {
      const f = await fixture(method);
      const result = await f.run();
      expect(result.code, result.err).toBe(0);
      expect(JSON.parse(result.out)).toEqual([]);
      expect(f.requests).toEqual([
        expect.objectContaining({
          target: "local",
          path: "/api/system/cli-session",
          internal: f.internal,
          bearer: undefined,
        }),
        expect.objectContaining({
          target: "local",
          path: "/api/projects",
          internal: undefined,
          bearer: `Bearer ${f.token}`,
        }),
        expect.objectContaining({
          target: "local",
          path: "/api/auth/sign-out",
          internal: undefined,
          bearer: `Bearer ${f.token}`,
        }),
      ]);
      expect(result.out + result.err).not.toContain(f.internal);
      expect(result.out + result.err).not.toContain(f.token);
      await expect(readFile(f.configPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("uses --local without changing the remote default or inheriting ambient Cloud authority", async () => {
    const f = await fixture();
    const remote = {
      apiUrl: f.endpoints.remote,
      token: "opsh_pat_remote",
      organizationId: "org-remote",
    };
    await f.configure({ cloud: remote });
    const result = await f.run(["--local", "project", "list"], {
      OPENSHIP_API_URL: f.endpoints.remote,
      OPENSHIP_TOKEN: "opsh_pat_ambient",
      OPENSHIP_ORGANIZATION_ID: "org-ambient",
    });
    expect(result.code, result.err).toBe(0);
    expect(f.requests.every((r) => r.target === "local" && r.organization === undefined)).toBe(
      true,
    );
    expect(JSON.parse(await readFile(f.configPath, "utf8"))).toEqual({
      current: "cloud",
      contexts: { cloud: remote },
    });
  });

  it.each(["default", "context", "environment", "api-url"])(
    "never adds local authority to an explicit remote %s",
    async (mode) => {
      const f = await fixture();
      await f.configure({ remote: { apiUrl: f.endpoints.remote } });
      const flags =
        mode === "context"
          ? ["--context", "remote"]
          : mode === "api-url"
            ? ["--api-url", f.endpoints.remote]
            : [];
      const result = await f.run(
        [...flags, "project", "list"],
        mode === "environment" ? { OPENSHIP_API_URL: f.endpoints.remote } : {},
      );
      expect(result.code, result.err).toBe(0);
      expect(f.requests).toEqual([
        expect.objectContaining({
          target: "remote",
          path: "/api/projects",
          internal: undefined,
          bearer: undefined,
        }),
      ]);
    },
  );

  it("keeps an explicit limited credential even when its URL is the local installation", async () => {
    const f = await fixture();
    await f.configure({ limited: { apiUrl: f.endpoints.local, token: "opsh_pat_limited" } });
    f.control.resourceStatus = 403;
    const result = await f.run();
    expect(result.code).toBe(1);
    expect(f.requests).toEqual([
      expect.objectContaining({
        path: "/api/projects",
        internal: undefined,
        bearer: "Bearer opsh_pat_limited",
      }),
    ]);
  });

  it("signs out its temporary session after a failed command", async () => {
    const f = await fixture();
    f.control.resourceStatus = 403;
    expect((await f.run()).code).toBe(1);
    expect(f.requests.at(-1)?.path).toBe("/api/auth/sign-out");
  });

  it("cannot redirect the installation credential to another endpoint", async () => {
    const f = await fixture();
    f.control.redirect = f.endpoints.remote + "/api/system/cli-session";
    expect((await f.run()).code).toBe(1);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].target).toBe("local");
  });

  it.each([401, 404, 409, 500])(
    "stops before resource requests when exchange fails with %s",
    async (status) => {
      const f = await fixture();
      f.control.exchangeStatus = status;
      const result = await f.run();
      expect(result.code).toBe(1);
      expect(f.requests).toHaveLength(1);
      expect(result.out + result.err).not.toContain(f.internal);
      if (status === 404) expect(result.err).toContain("Update the server");
    },
  );

  it("redacts malformed credential responses and never sends them as a bearer", async () => {
    const f = await fixture();
    f.control.invalidResponse = true;
    const result = await f.run();
    expect(result.code).toBe(1);
    expect(result.out + result.err).not.toContain(f.internal);
    expect(f.requests).toHaveLength(1);
  });

  it("keeps --schema usable without authenticating or contacting the installed server", async () => {
    const f = await fixture();
    expect((await f.run(["--local", "project", "options", "proj_fixture", "--schema"])).code).toBe(
      0,
    );
    expect(f.requests).toEqual([]);
  });

  it("can diagnose and repair locally without a working session endpoint", async () => {
    const f = await fixture();
    f.control.exchangeStatus = 500;
    // This fixture has no embedded database: doctor must reach its ordinary
    // nothing-to-repair result without creating a session or starting a service.
    const result = await f.run(["--local", "doctor", "--fix"]);
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain("nothing to repair");
    expect(f.requests).toEqual([]);
  });

  it("validates mutation confirmation before obtaining any local session", async () => {
    const f = await fixture();
    const result = await f.run(["--local", "project", "delete", "proj_fixture"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("--yes");
    expect(f.requests).toEqual([]);
  });

  it("requires the installation credential for explicit --local, and never mints a replacement", async () => {
    const f = await fixture();
    await rm(join(f.directory, "internal-token"));
    const result = await f.run(["--local", "project", "list"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("no internal token");
    expect(f.requests).toEqual([]);
    await expect(readFile(join(f.directory, "internal-token"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
