import { mkdirSync, existsSync, readFileSync, unlinkSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import type { Pool } from "pg";
import { sleep } from "@repo/core";
import * as schema from "./schema";
import { acquirePgliteLock, releasePgliteLock } from "./pglite-lock";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Unified database type - works regardless of driver (pg or PGlite).
 * Every repo and service receives this; they never know which driver runs beneath.
 */
export type Database = NodePgDatabase<typeof schema> | PgliteDatabase<typeof schema>;

/** Which driver is active - useful for conditional logic in adapters */
export type Driver = "pg" | "pglite";

// ─── Internal state ──────────────────────────────────────────────────────────

let _driver: Driver;

export function getDriver(): Driver {
  return _driver;
}

/**
 * The raw node-postgres Pool, exposed so `withAdvisoryLock` can hold a
 * session-level lock on a dedicated connection. Only set for the `pg` driver;
 * PGlite has no pool (and doesn't need cross-process locking).
 */
let _pgPool: Pool | undefined;

/** Pool capacity shared by ordinary queries and session advisory locks. Lock
 *  callers reserve one slot below this ceiling so their callbacks can still
 *  execute repository queries instead of deadlocking the whole pool. */
export const PG_POOL_MAX = 20;

export function getPgPool(): Pool {
  if (!_pgPool) {
    throw new Error("Postgres pool is unavailable (active driver is not 'pg')");
  }
  return _pgPool;
}

/** Live PGlite client, kept so closeDb() can close it and free the lock. */
let _pgliteClient: { close(): Promise<void> } | undefined;

/**
 * Release all database resources. For PGlite this closes the WASM instance and
 * frees the single-instance lock so the next process can open the dir cleanly;
 * for node-postgres it drains the pool. Safe to call more than once; call from
 * graceful shutdown.
 */
export async function closeDb(): Promise<void> {
  if (_pgliteClient) {
    try {
      await _pgliteClient.close();
    } catch {
      /* best effort — we're shutting down */
    }
    _pgliteClient = undefined;
  }
  if (_pgPool) {
    try {
      await _pgPool.end();
    } catch {
      /* best effort */
    }
    _pgPool = undefined;
  }
  releasePgliteLock();
}

// ─── Resolved paths ─────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
// `../drizzle` resolves into the read-only embedded FS when this module is
// baked into a `bun build --compile` binary (the desktop app), where the .sql
// files aren't present. OPENSHIP_MIGRATIONS_DIR points that build at the
// migrations shipped alongside the binary as a data asset.
const MIGRATIONS_DIR = process.env.OPENSHIP_MIGRATIONS_DIR ?? resolve(__dirname, "../drizzle");

// ─── Data directory ──────────────────────────────────────────────────────────

/**
 * Resolves the PGlite data directory from environment or convention.
 *
 * Priority:
 *   1) PGLITE_DATA_DIR env var - explicit path (recommended for self-hosted)
 *   2) Default: ~/.openship/data  (outside the project, won't be committed)
 */
function resolvePgliteDataDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";

  const explicit = process.env.PGLITE_DATA_DIR;
  if (explicit) {
    // Expand a leading ~ ourselves: env files (loaded via `node --env-file`) do
    // NOT shell-expand, so `PGLITE_DATA_DIR=~/.openship/data-saas` would
    // otherwise resolve literally. `resolve` handles relative paths from cwd.
    const expanded =
      explicit === "~" || explicit.startsWith("~/")
        ? resolve(home, explicit.slice(1).replace(/^\/+/, ""))
        : explicit;
    return resolve(expanded);
  }

  return resolve(home, ".openship", "data");
}

// ─── Client factory ──────────────────────────────────────────────────────────

/**
 * Creates and returns a typed Drizzle database instance.
 *
 * Driver selection based on DATABASE_URL:
 *   postgres://...  → node-postgres Pool  (production / Docker self-host)
 *   empty / absent  → PGlite embedded     (zero-config dev, no Docker)
 *
 * PGlite data location (when active):
 *   PGLITE_DATA_DIR  → explicit path (self-hosted customisation)
 *   _(default)_      → ~/.openship/data  (outside the project)
 *
 * Migrations run automatically at startup from `packages/db/drizzle/`.
 * Schema changes → `pnpm db:generate` → commit the new migration → restart.
 */
/**
 * Resolve the Postgres connection string.
 *
 * `DATABASE_URL` wins when set. Otherwise we compose one from discrete vars, so
 * you can set `POSTGRES_PASSWORD` (etc.) — the SAME names docker-compose uses for
 * the postgres service — instead of embedding the password in a full URL and
 * duplicating it. Accepts both `POSTGRES_*` (compose convention) and standard
 * libpq `PG*` names. An empty result → PGlite embedded (zero-config dev).
 */
function resolveDatabaseUrl(): string {
  const explicit = process.env.DATABASE_URL?.trim();
  if (explicit) return explicit;

  const host = process.env.POSTGRES_HOST ?? process.env.PGHOST;
  const password = process.env.POSTGRES_PASSWORD ?? process.env.PGPASSWORD;
  // Only compose a URL when the operator clearly intends a real Postgres —
  // otherwise fall through to PGlite (dev default).
  if (!host && !password) return "";

  const user = process.env.POSTGRES_USER ?? process.env.PGUSER ?? "openship";
  const port = process.env.POSTGRES_PORT ?? process.env.PGPORT ?? "5432";
  const db = process.env.POSTGRES_DB ?? process.env.PGDATABASE ?? user;
  const auth = password
    ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}`
    : encodeURIComponent(user);
  return `postgresql://${auth}@${host ?? "localhost"}:${port}/${db}`;
}

async function createDb(): Promise<Database> {
  const url = resolveDatabaseUrl();

  if (url.startsWith("postgres")) {
    return createPgClient(url);
  }

  return createPgliteClient();
}

// ─── PostgreSQL (node-postgres) ──────────────────────────────────────────────

/**
 * How long boot waits for Postgres to start answering before it gives up.
 *
 * Compose gates the api on `postgres: {condition: service_healthy}`, which covers
 * every start COMPOSE drives — but not the ones Docker drives on its own. A
 * `restart: unless-stopped` bounce (host reboot, postgres restarted or OOM-killed,
 * the daemon coming back) ignores depends_on entirely, and Postgres running its own
 * crash recovery can be tens of seconds behind us. Without a wait, boot connected
 * once, threw, and exited — so the api came back as a crash loop whose logs blamed
 * a DNS failure (Bun reports an unresolvable compose alias as `DNSException
 * getaddrinfo ECONNREFUSED`) rather than the mundane truth that postgres was late.
 *
 * 90s covers crash recovery on a small box without waiting so long that a genuinely
 * misconfigured DATABASE_URL looks like a hang. `0` opts out (fail on the first miss).
 *
 * Parsed defensively: a bare `Number()` turns a typo'd override into NaN, and every
 * comparison against NaN is false — which would make the loop below wait FOREVER, a
 * worse failure than the one it exists to fix. An unusable value falls back to the
 * default rather than changing the shape of boot.
 */
function positiveMs(value: unknown, fallback: number): number {
  const parsed = value === undefined || value === null ? Number.NaN : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const PG_READY_BUDGET_MS = positiveMs(process.env.OPENSHIP_DB_CONNECT_TIMEOUT_MS, 90_000);
const PG_READY_RETRY_MS = 1_000;

/**
 * Connection failures that no amount of waiting will fix, so boot fails NOW with the
 * real error instead of after the budget.
 *
 * Keeping this list — rather than an allowlist of retryable errors — is deliberate:
 * this whole wait exists because an error class we hadn't enumerated (Bun labelling a
 * DNS miss `ECONNREFUSED`) turned a two-second delay into a permanent crash loop. An
 * unknown error costs one bounded wait and then reports itself; an unknown error we
 * refuse to retry costs the operator their install.
 *
 * 28P01/28000 are the #488 signal (`.env` no longer matches the data volume) and 3D000
 * is a missing database — each needs an operator, and each must stay fast and legible.
 */
const FATAL_PG_CONNECT_CODES = new Set(["28P01", "28000", "3D000"]);

function isFatalConnectError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && FATAL_PG_CONNECT_CODES.has(code);
}

/**
 * Block until the pool hands out a working connection, or the budget runs out.
 *
 * Acquire-and-release rather than a query: it exercises DNS, the TCP connect and the
 * auth handshake — every layer that can be "not ready yet" — and nothing else.
 *
 * Not re-exported by the package barrel; `budgetMs`/`retryMs` are overridable so the
 * tests can drive the budget-exhausted path without sitting through it.
 */
export async function awaitPgReady(
  pool: Pool,
  opts: { budgetMs?: number; retryMs?: number } = {},
): Promise<void> {
  // Normalized through the same guard as the env override: a NaN budget would make
  // every deadline comparison false and hang boot indefinitely.
  const budgetMs = positiveMs(opts.budgetMs, PG_READY_BUDGET_MS);
  const retryMs = positiveMs(opts.retryMs, PG_READY_RETRY_MS);
  const startedAt = Date.now();
  let attempt = 0;

  for (;;) {
    attempt++;
    try {
      const client = await pool.connect();
      client.release();
      if (attempt > 1) {
        const waited = Math.round((Date.now() - startedAt) / 1000);
        console.log(`[db] postgres accepted a connection after ${waited}s (${attempt} attempts)`);
      }
      return;
    } catch (err) {
      if (isFatalConnectError(err)) throw err;

      const elapsed = Date.now() - startedAt;
      if (elapsed + retryMs >= budgetMs) {
        // Re-thrown as-is: the driver's message names the host, port and cause, and
        // that is what the operator needs to see at the top of the crash.
        throw err;
      }
      // One line on the first miss, then every 10th, so a slow start is visible in
      // `docker logs` without burying it.
      if (attempt === 1 || attempt % 10 === 0) {
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(
          `[db] postgres not ready yet (attempt ${attempt}, ${Math.round(elapsed / 1000)}s` +
            `/${Math.round(budgetMs / 1000)}s): ${reason}`,
        );
      }
      await sleep(retryMs);
    }
  }
}

async function createPgClient(url: string): Promise<Database> {
  _driver = "pg";
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const pool = new Pool({
    connectionString: url,
    max: PG_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  // node-postgres re-emits errors raised on IDLE clients on the pool itself, and an
  // EventEmitter with no 'error' listener THROWS — so a postgres restart under a
  // long-running api took the whole process down from outside any try/catch, hours
  // after the boot this file worries about. The pool retires the dead client on its
  // own; all this has to do is exist. Attached before the first connect so no window
  // is uncovered.
  pool.on("error", (err) => {
    console.warn("[db] idle postgres client error (connection retired):", err.message);
  });
  _pgPool = pool;

  // Before migrate(), which is the first thing to touch the network and so the thing
  // that used to turn "postgres is 2s late" into an exited process.
  await awaitPgReady(pool);

  const db = drizzle(pool, { schema });

  // Run pending migrations
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

  return db;
}

// ─── PGlite (embedded PostgreSQL) ────────────────────────────────────────────

/**
 * Remove PGlite's own leftover `postmaster.pid` before opening. PGlite writes a
 * `-42` sentinel there and refuses to boot if it finds a stale one after a
 * crash. This runs ONLY after acquirePgliteLock() has granted us exclusive
 * access, so any leftover is provably from a dead run — never a live process.
 * (The real cross-process guard is acquirePgliteLock; this just clears PGlite's
 * internal bookkeeping so the WASM cluster starts.)
 */
function clearStalePgliteControlFile(dataDir: string): void {
  const controlPath = join(dataDir, "postmaster.pid");
  if (!existsSync(controlPath)) return;
  try {
    unlinkSync(controlPath);
  } catch (err) {
    console.warn(
      `[db] failed to remove stale pglite postmaster.pid at ${controlPath}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * When @repo/db is baked into a `bun build --compile` binary (the desktop app),
 * pglite's own `pglite.wasm`/`pglite.data` aren't on disk beside its module — it
 * looks for them in the read-only embedded FS (`/$bunfs/root/…`) and fails.
 * OPENSHIP_PGLITE_ASSETS_DIR points at copies shipped alongside the binary; we
 * hand them to PGlite directly so it never resolves its own module dir.
 */
async function resolvePgliteAssets() {
  const dir = process.env.OPENSHIP_PGLITE_ASSETS_DIR;
  if (!dir) return undefined;
  // WebAssembly is a bun/node runtime global, but not in this package's TS lib
  // (ES2022 + @types/node). Reach it via a typed globalThis cast so @repo/db
  // typechecks without pulling in the DOM lib.
  const { WebAssembly } = globalThis as unknown as {
    WebAssembly: { compile(bytes: Uint8Array): Promise<unknown> };
  };
  const wasmModule = await WebAssembly.compile(readFileSync(join(dir, "pglite.wasm")));
  const fsBundle = new Blob([readFileSync(join(dir, "pglite.data"))]);
  return { wasmModule, fsBundle };
}

async function createPgliteClient(): Promise<Database> {
  _driver = "pglite";

  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");

  // Under test, NEVER touch the on-disk dev data dir. pglite is a
  // single-process embedded Postgres — a test run that imports @repo/db
  // (this module eagerly opens the DB at import) while the dev server is
  // also running would open the SAME data dir from two processes and
  // corrupt it (WASM "Aborted()" on next boot). An ephemeral in-memory
  // instance is fully isolated per process and needs no lock/dir.
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    const memClient = new PGlite("memory://");
    const memDb = drizzle(memClient, { schema });
    await migrate(memDb, { migrationsFolder: MIGRATIONS_DIR });
    return memDb;
  }

  const dataDir = resolvePgliteDataDir();
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  // Guarantee single-process access BEFORE opening. PGlite has no real
  // cross-process lock, and two openers corrupt the WASM cluster irrecoverably.
  // Wait up to the full graceful-shutdown window (index.ts caps shutdown at
  // 30s) so a hot-reload / restart handoff — where the previous process is
  // still draining + releasing the DB — reliably succeeds instead of racing a
  // 5s window (the recurring "already using the database" reload failure). A
  // crashed predecessor is reclaimed instantly (dead pid), so this only ever
  // waits while a LIVE predecessor is actively shutting down.
  await acquirePgliteLock(dataDir, { waitMs: 30_000, pollMs: 250 });
  clearStalePgliteControlFile(dataDir);

  const assets = await resolvePgliteAssets();
  const client = assets ? new PGlite({ dataDir, ...assets }) : new PGlite(dataDir);
  _pgliteClient = client;
  const db = drizzle(client, { schema });

  // Run pending migrations. Drizzle wraps each migration in a transaction and
  // the lock guarantees we're the only writer, so this is atomic and race-free.
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

  return db;
}

// ─── Singleton export ────────────────────────────────────────────────────────

export const db = await createDb();
