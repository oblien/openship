/**
 * Upgrade a complete published Compose installation onto the exact new API,
 * dashboard and edge images. Frozen CLI templates retain the previous release's
 * healthchecks and dependency graph; the new side uses the production renderer.
 * Populated PostgreSQL/Redis volumes, custom ports, secrets and a saved edge route
 * survive replacement and a cold stack restart. A fresh install is checked too.
 *
 * CI runs both 0.9.3 (healthy baseline) and 0.9.4 (dashboard unhealthy, GH-1461).
 * Set OPENSHIP_E2E_NEW_{API,DASHBOARD,EDGE}_IMAGE to tested image digests.
 * Otherwise each image is built from this checkout. Requires an isolated Linux
 * Docker host: the actual host-network edge owns ports 80/443 on that host.
 */

import { beforeAll, afterAll, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { parse, stringify } from "yaml";
import { renderComposeYaml } from "../../../cli/src/lib/compose";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";

const REGISTRY = process.env.OPENSHIP_E2E_IMAGE_REGISTRY ?? "ghcr.io/oblien";
const PROJECT = `openship-e2e-update-${process.pid}`;
const SEED_ID = "e2e-upgrade-seed";
const SEED_SERVER_HOST = "192.0.2.1";
const SEEDED_TABLES = ["organization", "project", "deployment", "servers"];
const ADMIN = {
  name: "Upgrade verification",
  email: "upgrade-verification@example.test",
  password: "Upgrade-Verification-Test-Only!",
};

/** Long enough for a cold pull + initdb + the whole migration chain on a CI runner. */
const BOOT_TIMEOUT_MS = 240_000;

/**
 * Budgets, as a hierarchy rather than three independent numbers.
 *
 * The first version of this file had them uncoordinated, and the arithmetic bit
 * immediately: 3 pull attempts × 10min == the 30min `beforeAll` ceiling exactly, so on a
 * slow link the setup could burn its ENTIRE budget fetching and leave nothing for the
 * upgrade it exists to run — which is precisely what happened (three attempts killed
 * mid-download, zero seconds spent testing). Fetching must be a fraction of setup, and
 * visibly so.
 */
const PULL_TIMEOUT_MS = 600_000;
const PULL_ATTEMPTS = 2;
const BUILD_TIMEOUT_MS = 1_800_000;
/** Fetching (pull + a possible local build) plus boot, with room left over. */
const SETUP_TIMEOUT_MS = PULL_TIMEOUT_MS * PULL_ATTEMPTS + BUILD_TIMEOUT_MS + BOOT_TIMEOUT_MS;

let workdir = "";
let apiPort = 0;
let dashboardPort = 0;
let edgePort = 0;
const components = ["api", "dashboard", "edge"] as const;
type Component = (typeof components)[number];
let newImages: Record<Component, string>;
let storageContainers: Record<string, string>;
let oldVersion = "";
let migrationsAfterOld = 0;
let oldApiImageId = "";
let savedSessionCookie = "";

function sh(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): { code: number; stdout: string; stderr: string } {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 300_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function compose(args: string[]): { code: number; stdout: string; stderr: string } {
  return sh("docker", ["compose", "-p", PROJECT, ...args], { cwd: workdir });
}

/** Fail with the command's own output — a red release gate must say why on line one. */
function composeOrThrow(args: string[], what: string): string {
  const r = compose(args);
  if (r.code !== 0) {
    throw new Error(
      `${what} failed (exit ${r.code})\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`,
    );
  }
  return r.stdout;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * The release to upgrade from: newest `v*.*.*` tag that isn't the one being built.
 * Prereleases are skipped — an rc is not what an operator is upgrading from.
 */
function resolvePreviousVersion(): string {
  const override = process.env.OPENSHIP_E2E_OLD_VERSION?.trim();
  if (override && override !== "previous") return override.replace(/^v/, "");

  const atHead = new Set(
    sh("git", ["tag", "--points-at", "HEAD"])
      .stdout.split("\n")
      .map((t) => t.trim())
      .filter(Boolean),
  );
  const tags = sh("git", ["tag", "--list", "v*.*.*", "--sort=-v:refname"])
    .stdout.split("\n")
    .map((t) => t.trim())
    .filter((t) => t && !t.includes("-") && !atHead.has(t));

  if (!tags.length) {
    throw new Error(
      "No previous v*.*.* tag to upgrade from. CI must check out with fetch-depth: 0, " +
        "or set OPENSHIP_E2E_OLD_VERSION.",
    );
  }
  return tags[0]!.replace(/^v/, "");
}

/**
 * Pull the old side up front, with retries.
 *
 * Registry reads flake — a `manifest inspect` against a tag that demonstrably exists
 * returned "not found" once while this was being written. A gate that blocks releases
 * must not turn that into a red release, but it must not paper over a genuinely missing
 * image either: retry, then fail naming the ref and the override. Deliberately NOT
 * "walk back to an older release that does resolve" — that would quietly test an
 * upgrade nobody asked about.
 */
function pullOrThrow(ref: string, attempts = PULL_ATTEMPTS): void {
  let last = "";
  for (let i = 1; i <= attempts; i += 1) {
    const r = sh("docker", ["pull", ref], { timeoutMs: PULL_TIMEOUT_MS });
    if (r.code === 0) return;
    last = `${r.stdout}\n${r.stderr}`.trim();
  }
  throw new Error(
    `Could not pull ${ref} after ${attempts} attempts — the previous release's image has to ` +
      `exist for there to be an upgrade to test. Override with OPENSHIP_E2E_OLD_VERSION ` +
      `if this release genuinely has no published predecessor.\n${last}`,
  );
}

/**
 * The api image for the new side. CI hands us the digest `build-images` pushed; without
 * one we build this checkout, so the test is runnable on a laptop.
 */
function resolveNewImage(component: Component): string {
  const override = process.env[`OPENSHIP_E2E_NEW_${component.toUpperCase()}_IMAGE`]?.trim();
  if (override) {
    if (sh("docker", ["image", "inspect", override]).code !== 0) pullOrThrow(override);
    return override;
  }

  const tag = `openship/e2e-update-${component}:${process.pid}`;
  const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
  const built = sh(
    "docker",
    ["build", "-f", join("apps", component, "Dockerfile"), "-t", tag, "."],
    { cwd: repoRoot, timeoutMs: BUILD_TIMEOUT_MS },
  );
  if (built.code !== 0) {
    throw new Error(
      `Could not build the ${component} image for the new side.\n${built.stdout}\n${built.stderr}`,
    );
  }
  return tag;
}

/** The real templates, with only resource names and host paths isolated. */
function writeStack(previous: boolean): void {
  const yaml = previous
    ? readFileSync(
        join(import.meta.dirname, `../fixtures/upgrade/compose-${oldVersion}.yml`),
        "utf8",
      )
    : renderComposeYaml();
  const stack = parse(yaml);
  for (const component of components) {
    const service = stack.services[component];
    service.image = previous
      ? `${REGISTRY}/openship-${component}:${oldVersion}`
      : newImages[component];
    service.environment ??= {};
    if (component === "api") service.environment.OPENSHIP_EDGE_CONTAINER = `${PROJECT}-edge`;
    // The socket belongs to this disposable daemon. Routing state is shared by
    // the real API and edge at their normal container paths, under one test root.
    if (service.volumes)
      service.volumes = service.volumes.flatMap((mount: string | { target: string }) => {
        // Official images are public; never copy the operator's registry
        // credentials into the disposable control plane.
        if (typeof mount !== "string") {
          if (mount.target === "/root/.docker/config.json") return [];
          throw new Error(`Unexpected long-form test mount: ${mount.target}`);
        }
        const match = mount.match(/^([^:$]+):(\/[^:]+)(?::([a-z,]+))?$/);
        if (!match || match[1] === "/dev/null" || match[1] === "/var/run/docker.sock") return mount;
        const source = join(workdir, "mounts", match[2]);
        mkdirSync(source, { recursive: true });
        return `${source}:${match[2]}${match[3] ? `:${match[3]}` : ""}`;
      });
  }
  stack.services.edge.container_name = `${PROJECT}-edge`;
  writeFileSync(join(workdir, "docker-compose.yml"), stringify(stack));
}

function writeEnv(): void {
  writeFileSync(
    join(workdir, ".env"),
    [
      `COMPOSE_PROJECT_NAME=${PROJECT}`,
      `API_PORT=${apiPort}`,
      `DASHBOARD_PORT=${dashboardPort}`,
      `OPENSHIP_PUBLIC_URL=http://127.0.0.1:${edgePort}`,
      "POSTGRES_USER=openship",
      "POSTGRES_PASSWORD=e2e-upgrade-password",
      "POSTGRES_DB=openship",
      "BETTER_AUTH_SECRET=e2e0000000000000000000000000000000000000000000000000000000000000f",
      "INTERNAL_TOKEN=e2e-internal-token",
      "",
    ].join("\n"),
  );
}

function writeSavedRoute(): void {
  const sites = join(workdir, "mounts/usr/local/openresty/nginx/conf/sites-enabled");
  mkdirSync(sites, { recursive: true });
  writeFileSync(
    join(sites, "upgrade-check.conf"),
    `server {
    listen 127.0.0.1:${edgePort};
    server_name upgrade.example.test;
    location / { proxy_pass http://127.0.0.1:${dashboardPort}; }
  }\n`,
  );
}

function containerId(service: string): string {
  const id = composeOrThrow(["ps", "-aq", service], `finding ${service}`).trim();
  expect(id, `${service} container should exist`).not.toBe("");
  return id;
}

function inspect(service: string) {
  return JSON.parse(sh("docker", ["inspect", containerId(service)]).stdout)[0];
}

async function expectDashboardAndEdge(): Promise<void> {
  const probe = compose([
    "exec",
    "-T",
    "dashboard",
    "node",
    "-e",
    "fetch('http://127.0.0.1:'+process.env.PORT+'/login').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))",
  ]);
  expect(probe.code, `dashboard loopback probe: ${probe.stderr}`).toBe(0);
  const login = await waitForEdgeLogin();
  expect(login.status, "the saved edge route should reach the dashboard").toBe(200);
  expect(await login.text()).toMatch(/openship/i);
  const api = await fetch(`http://127.0.0.1:${edgePort}/api/proxy/api/health`);
  expect(api.ok, "the dashboard same-origin proxy should reach the API").toBe(true);
}

async function waitForEdgeLogin(): Promise<Response> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let last = "No response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${edgePort}/login`, {
        signal: AbortSignal.timeout(3000),
      });
      if (response.status === 200) return response;
      last = `HTTP ${response.status}`;
      await response.body?.cancel();
    } catch (error) {
      last = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `The saved dashboard edge route did not become ready: ${last}\n${compose(["logs", "--tail", "40", "dashboard", "edge"]).stdout}`,
  );
}

async function bootstrapAdmin(): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${apiPort}/api/system/bootstrap-admin`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Internal-Token": "e2e-internal-token" },
    body: JSON.stringify(ADMIN),
  });
  expect(response.status, "normal first-admin bootstrap should succeed").toBe(200);
  await response.body?.cancel();
}

async function expectAdminLogin(throughEdge = true): Promise<void> {
  const base = throughEdge
    ? `http://127.0.0.1:${edgePort}/api/proxy`
    : `http://127.0.0.1:${apiPort}`;
  const response = await fetch(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${edgePort}` },
    body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
  });
  expect(response.status, "the saved admin credentials should still sign in").toBe(200);
  if (!throughEdge) {
    savedSessionCookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    expect(savedSessionCookie, "the previous release must issue a session cookie").not.toBe("");
  }
  const body = await response.json();
  expect(body).toMatchObject({ user: { email: ADMIN.email } });
}

async function expectRetainedSession(): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${edgePort}/api/proxy/api/auth/get-session`, {
    headers: { Cookie: savedSessionCookie },
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body, "the pre-upgrade signed session should remain valid").toMatchObject({
    user: { email: ADMIN.email },
  });
}

/** One psql statement batch as the cluster superuser. */
function psql(sql: string): string {
  const r = compose([
    "exec",
    "-T",
    "postgres",
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "openship",
    "-d",
    "openship",
    "-tAc",
    sql,
  ]);
  if (r.code !== 0) {
    throw new Error(`psql failed (exit ${r.code})\nSQL: ${sql}\n${r.stdout}\n${r.stderr}`);
  }
  return r.stdout.trim();
}

function appliedMigrations(): number {
  return Number(psql(`select count(*) from drizzle."__drizzle_migrations"`));
}

/**
 * Insert one row into `table`, with the INSERT built from the schema AS THE OLD RELEASE
 * LEFT IT. Introspection rather than a column list, for the same reason as the
 * migrate-chain suite: the old side moves every release, and a hardcoded list would
 * break on the first migration that touched any of these tables. Keep a valid SSH
 * host even when that column is nullable: managed servers made it conditional on
 * workspace ownership, not optional for an ordinary server.
 */
function seedRow(table: string): void {
  psql(`
    SET session_replication_role = replica;
    DO $seed$
    DECLARE cols text; vals text;
    BEGIN
      SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position),
             string_agg(
               CASE
                 WHEN column_name = 'id' THEN quote_literal('${SEED_ID}')
                 WHEN '${table}' = 'servers' AND column_name = 'ssh_host' THEN quote_literal('${SEED_SERVER_HOST}')
                 WHEN data_type IN ('text','character varying','character') THEN quote_literal('seed')
                 WHEN data_type = 'uuid' THEN quote_literal('00000000-0000-0000-0000-000000000001')
                 WHEN data_type LIKE 'timestamp%' OR data_type = 'date' THEN 'now()'
                 WHEN data_type = 'boolean' THEN 'false'
                 WHEN data_type IN ('integer','bigint','smallint','numeric','real','double precision') THEN '0'
                 WHEN data_type IN ('json','jsonb') THEN quote_literal('{}')
                 WHEN data_type = 'ARRAY' THEN quote_literal('{}')
                 ELSE quote_literal('seed')
               END, ', ' ORDER BY ordinal_position)
        INTO cols, vals
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = '${table}'
         AND is_generated = 'NEVER'
         AND identity_generation IS NULL
         -- id is forced in even when it has a default: the assertions find the row by it.
         AND (column_name = 'id'
           OR ('${table}' = 'servers' AND column_name = 'ssh_host')
           OR (is_nullable = 'NO' AND column_default IS NULL));
      EXECUTE format('INSERT INTO %I (%s) VALUES (%s)', '${table}', cols, vals);
    END
    $seed$;
  `);
}

function rowCount(table: string): number {
  return Number(psql(`select count(*) from "${table}" where id = '${SEED_ID}'`));
}

async function waitForHealth(label: string): Promise<void> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${apiPort}/api/health`);
      if (res.ok) return;
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  // The api's own logs, or the failure names nothing actionable.
  const logs = compose(["logs", "--tail", "60", "api"]).stdout;
  throw new Error(
    `${label}: /api/health never became ready within ${BOOT_TIMEOUT_MS / 1000}s ` +
      `(last: ${lastErr})\n--- api logs ---\n${logs}`,
  );
}

function apiContainerId(): string {
  const id = compose(["ps", "-q", "api"]).stdout.trim().split("\n")[0] ?? "";
  expect(id, "api container should exist").not.toBe("");
  return id;
}

function apiRestartCount(): number {
  return Number(
    sh("docker", ["inspect", "--format", "{{.RestartCount}}", apiContainerId()]).stdout.trim(),
  );
}

/**
 * The image the api container is actually RUNNING, as a content ID.
 *
 * Compared before/after rather than the image reference: both sides are the same repo,
 * so a name check ("does it contain openship-api") passes identically for the old
 * release and proves nothing about which one is up.
 */
function apiImageId(): string {
  return sh("docker", ["inspect", "--format", "{{.Image}}", apiContainerId()]).stdout.trim();
}

describeDockerE2E("update from the previous release", () => {
  beforeAll(async () => {
    await requireDocker();

    oldVersion = resolvePreviousVersion();
    apiPort = await freePort();
    workdir = mkdtempSync(join(tmpdir(), "openship-e2e-update-"));
    dashboardPort = await freePort();
    edgePort = await freePort();
    writeEnv();
    writeStack(true);
    writeSavedRoute();

    // ── Phase 1: the previous release, exactly as an operator is running it now.
    for (const component of components)
      pullOrThrow(`${REGISTRY}/openship-${component}:${oldVersion}`);
    const boot = compose(["up", "-d"]);
    if (oldVersion === "0.9.4") {
      expect(boot.code, "GH-1461 must reproduce on the original 0.9.4 template").not.toBe(0);
      expect(inspect("dashboard").State.Health.Status).toBe("unhealthy");
    } else {
      expect(boot.code, boot.stderr).toBe(0);
      const login = await waitForEdgeLogin();
      expect(login.status).toBe(200);
    }
    await waitForHealth(`previous release (${oldVersion})`);
    await bootstrapAdmin();
    await expectAdminLogin(false);

    migrationsAfterOld = appliedMigrations();
    oldApiImageId = apiImageId();

    // ── Phase 2's precondition: rows, so the migrations below run against data.
    for (const table of SEEDED_TABLES) seedRow(table);

    storageContainers = Object.fromEntries(
      ["postgres", "redis"].map((name) => [name, containerId(name)]),
    );
    composeOrThrow(
      ["exec", "-T", "redis", "redis-cli", "SET", "upgrade-check", "preserved"],
      "seeding Redis",
    );
    newImages = Object.fromEntries(
      components.map((component) => [component, resolveNewImage(component)]),
    ) as Record<Component, string>;
  }, SETUP_TIMEOUT_MS);

  afterAll(() => {
    if (workdir) {
      compose(["down", "-v", "--remove-orphans"]);
      rmSync(workdir, { recursive: true, force: true });
    }
  }, 300_000);

  it("the previous release migrated the database and holds the seeded rows", () => {
    // Anti-vacuity: if the old api never migrated, or the seeding quietly did nothing,
    // then "the upgrade worked" below would be a statement about an empty database.
    expect(migrationsAfterOld).toBeGreaterThan(10);
    for (const table of SEEDED_TABLES) {
      expect(rowCount(table), `${table} was not seeded on ${oldVersion}`).toBe(1);
    }
    expect(psql(`select ssh_host from servers where id = '${SEED_ID}'`)).toBe(SEED_SERVER_HOST);
  });

  it("recreates onto this release's image and comes up healthy, with the data intact", async () => {
    const savedEnv = readFileSync(join(workdir, ".env"), "utf8");
    writeStack(false);
    // Exact application cohort and readiness wait used by composeUpdate.
    composeOrThrow(
      ["up", "-d", "--force-recreate", "--wait", "--wait-timeout", "180", ...components],
      "upgrading the complete control plane",
    );
    expect(readFileSync(join(workdir, ".env"), "utf8")).toBe(savedEnv);

    await waitForHealth("new release");
    await expectDashboardAndEdge();
    await expectRetainedSession();
    await expectAdminLogin();
    for (const name of ["postgres", "redis"])
      expect(containerId(name)).toBe(storageContainers[name]);
    expect(
      composeOrThrow(
        ["exec", "-T", "redis", "redis-cli", "GET", "upgrade-check"],
        "reading retained Redis data",
      ).trim(),
    ).toBe("preserved");
    for (const component of components) {
      const state = inspect(component);
      expect(state.State.Running).toBe(true);
      expect(state.RestartCount).toBe(0);
      if (component !== "edge") expect(state.State.Health.Status).toBe("healthy");
      const expected = sh("docker", [
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        newImages[component],
      ]).stdout.trim();
      expect(state.Image, `${component} must run the exact tested image`).toBe(expected);
    }

    // Migrations moved forward (or were already complete) and nothing was lost.
    const after = appliedMigrations();
    expect(after).toBeGreaterThanOrEqual(migrationsAfterOld);
    for (const table of SEEDED_TABLES) {
      expect(rowCount(table), `${table} lost its row across the update`).toBe(1);
    }
    expect(psql(`select ssh_host from servers where id = '${SEED_ID}'`)).toBe(SEED_SERVER_HOST);

    // Healthy is not enough: `restart: unless-stopped` will bounce a container until
    // something works, so a crash loop that eventually succeeded still looks healthy
    // here. It must have come up on the FIRST attempt.
    expect(apiRestartCount(), "the api restarted on the way up — that is the crash loop").toBe(0);

    // And the running image actually CHANGED, or everything above is a statement about
    // the old release still being up.
    expect(oldApiImageId, "phase 1 image id should have been captured").not.toBe("");
    expect(apiImageId(), "the api is still running the previous release's image").not.toBe(
      oldApiImageId,
    );
  }, 600_000);

  it("starts the complete stack after a cold stop, with its data and saved route intact", async () => {
    composeOrThrow(["stop"], "stopping the test stack");
    composeOrThrow(
      ["up", "-d", "--wait", "--wait-timeout", "180"],
      "cold-starting the updated stack",
    );
    await waitForHealth("cold restart");
    await expectDashboardAndEdge();
    await expectRetainedSession();
    await expectAdminLogin();
    for (const table of SEEDED_TABLES) expect(rowCount(table)).toBe(1);
    expect(
      composeOrThrow(
        ["exec", "-T", "redis", "redis-cli", "GET", "upgrade-check"],
        "reading Redis after restart",
      ).trim(),
    ).toBe("preserved");
  }, 300_000);

  it("also boots a fresh complete installation on empty storage", async () => {
    composeOrThrow(
      ["down", "-v", "--remove-orphans"],
      "removing only the disposable upgrade stack",
    );
    composeOrThrow(
      ["up", "-d", "--wait", "--wait-timeout", "180"],
      "starting a fresh installation",
    );
    await waitForHealth("fresh install");
    await expectDashboardAndEdge();
    await bootstrapAdmin();
    await expectAdminLogin();
    for (const table of SEEDED_TABLES) expect(rowCount(table)).toBe(0);
    expect(appliedMigrations()).toBeGreaterThanOrEqual(migrationsAfterOld);
  }, 300_000);
});
