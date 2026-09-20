/**
 * THE UPDATE ITSELF: last release's stack, real data in it, recreated onto this
 * release's image. Real daemon, real Postgres, real containers.
 *
 * This is the case every other suite in the repo approximates and none of them runs.
 * `migrate-chain` (packages/db) proves the migration chain applies to a populated
 * database, but on PGlite — Postgres compiled to WASM, close but not the
 * `postgres:16-alpine` an operator actually has. Nothing anywhere booted the PREVIOUS
 * RELEASE and then updated it, which is the only sequence an existing user ever
 * performs, and the one that produced "openship-api-1 enters a crash loop after
 * `openship update`" from an operator whose 0.6.1 install was already unhealthy.
 *
 * What it does:
 *   1. Brings up postgres + redis + the PREVIOUS release's api image, waits for
 *      /api/health, and confirms that api actually migrated the database.
 *   2. Seeds rows into core tables, so what follows runs against a NON-EMPTY schema.
 *   3. Repins the api image to THIS release's and runs the same command
 *      `openship update` runs — `up -d --force-recreate api` — against the same
 *      volume, same .env, same network.
 *   4. Asserts the new api reaches /api/health, applied the remaining migrations,
 *      kept every seeded row, and did NOT bounce on the way (RestartCount 0 — a
 *      container that crash-looped its way to healthy is the failure being hunted).
 *
 * Deliberately narrower than `openship up`: postgres + redis + api, not edge/mail/
 * dashboard. The compose file below mirrors the shipped template for those three
 * services (apps/cli/src/lib/compose.ts) — how the CLI GENERATES that file is covered
 * by apps/cli/test/unit; what this owns is whether the update survives.
 *
 * Two inputs, because a checkout has neither side of an upgrade in it:
 *   OPENSHIP_E2E_NEW_API_IMAGE  the api image for the NEW side. CI passes the digest
 *                               `build-images` just pushed, so the bytes under test are
 *                               the bytes about to be tagged. Unset → built from this
 *                               checkout (slow, but makes the test runnable anywhere).
 *   OPENSHIP_E2E_OLD_VERSION    the release to upgrade FROM. Unset → the newest
 *                               `v*.*.*` tag that isn't the one at HEAD.
 *
 * Opt-in via `E2E_SCOPE=update` (see vitest.e2e.config.ts): it pulls a published
 * release, which a plain local checkout has no reason to do on every run.
 */

import { beforeAll, afterAll, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";

const REGISTRY = process.env.OPENSHIP_E2E_IMAGE_REGISTRY ?? "ghcr.io/oblien";
const PROJECT = `openship-e2e-update-${process.pid}`;
const SEED_ID = "e2e-upgrade-seed";
const SEEDED_TABLES = ["organization", "project", "deployment", "servers"];

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
let oldVersion = "";
let newApiImage = "";
let migrationsAfterOld = 0;
let oldApiImageId = "";

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
    throw new Error(`${what} failed (exit ${r.code})\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`);
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
  if (override) return override.replace(/^v/, "");

  const atHead = new Set(
    sh("git", ["tag", "--points-at", "HEAD"]).stdout.split("\n").map((t) => t.trim()).filter(Boolean),
  );
  const tags = sh("git", ["tag", "--list", "v*.*.*", "--sort=-v:refname"]).stdout
    .split("\n")
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
function resolveNewApiImage(): string {
  const override = process.env.OPENSHIP_E2E_NEW_API_IMAGE?.trim();
  if (override) return override;

  const tag = `openship/e2e-update-api:${process.pid}`;
  const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
  const built = sh(
    "docker",
    ["build", "-f", join("apps", "api", "Dockerfile"), "-t", tag, "."],
    { cwd: repoRoot, timeoutMs: BUILD_TIMEOUT_MS },
  );
  if (built.code !== 0) {
    throw new Error(
      `Could not build the api image for the new side.\n${built.stdout}\n${built.stderr}`,
    );
  }
  return tag;
}

/**
 * postgres + redis + api, mirroring the shipped template: PGDATA in a SUBDIRECTORY of
 * the volume (#350), a pg_isready healthcheck, and — the part this test exists to
 * exercise — `depends_on: {condition: service_healthy}` on the api.
 *
 * The api image is a variable so phase 2 can repin it the way `openship update` repins
 * OPENSHIP_VERSION, and recreate against the same volume.
 */
const COMPOSE_YAML = `services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      PGDATA: /var/lib/postgresql/data/pgdata
      POSTGRES_USER: \${POSTGRES_USER}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: \${POSTGRES_DB}
    expose: ["5432"]
    volumes: [postgres_data:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \${POSTGRES_USER} -d \${POSTGRES_DB}"]
      interval: 5s
      timeout: 3s
      retries: 12

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes"]
    expose: ["6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 12

  api:
    image: \${OPENSHIP_API_IMAGE}
    restart: unless-stopped
    ports: ["127.0.0.1:\${API_PORT}:\${API_PORT}"]
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    env_file: [.env]
    environment:
      NODE_ENV: production
      PORT: "\${API_PORT}"
      DATABASE_URL: postgresql://\${POSTGRES_USER}:\${POSTGRES_PASSWORD}@postgres:5432/\${POSTGRES_DB}
      REDIS_URL: redis://redis:6379
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }

volumes:
  postgres_data:
`;

function writeEnv(apiImage: string): void {
  writeFileSync(
    join(workdir, ".env"),
    [
      `OPENSHIP_API_IMAGE=${apiImage}`,
      `API_PORT=${apiPort}`,
      "POSTGRES_USER=openship",
      "POSTGRES_PASSWORD=e2e-upgrade-password",
      "POSTGRES_DB=openship",
      // Stable across both phases, exactly as `openship update` carries them forward:
      // a new BETTER_AUTH_SECRET would make every stored env var undecryptable (#488).
      "BETTER_AUTH_SECRET=e2e0000000000000000000000000000000000000000000000000000000000000f",
      "INTERNAL_TOKEN=e2e-internal-token",
      "",
    ].join("\n"),
  );
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
 * break on the first migration that touched any of these tables.
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
         AND (column_name = 'id' OR (is_nullable = 'NO' AND column_default IS NULL));
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
    writeFileSync(join(workdir, "docker-compose.yml"), COMPOSE_YAML);

    // ── Phase 1: the previous release, exactly as an operator is running it now.
    pullOrThrow(`${REGISTRY}/openship-api:${oldVersion}`);
    writeEnv(`${REGISTRY}/openship-api:${oldVersion}`);
    composeOrThrow(["up", "-d"], `bringing up the ${oldVersion} stack`);
    await waitForHealth(`previous release (${oldVersion})`);

    migrationsAfterOld = appliedMigrations();
    oldApiImageId = apiImageId();

    // ── Phase 2's precondition: rows, so the migrations below run against data.
    for (const table of SEEDED_TABLES) seedRow(table);

    newApiImage = resolveNewApiImage();
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
  });

  it("recreates onto this release's image and comes up healthy, with the data intact", async () => {
    // The update: repin the image and force-recreate ONLY the api, which is what
    // `openship update` does (composeUpdate → composeUp → up -d --force-recreate).
    writeEnv(newApiImage);
    composeOrThrow(["up", "-d", "--force-recreate", "api"], "recreating the api onto the new image");

    await waitForHealth("new release");

    // Migrations moved forward (or were already complete) and nothing was lost.
    const after = appliedMigrations();
    expect(after).toBeGreaterThanOrEqual(migrationsAfterOld);
    for (const table of SEEDED_TABLES) {
      expect(rowCount(table), `${table} lost its row across the update`).toBe(1);
    }

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
});
