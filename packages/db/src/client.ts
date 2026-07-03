import { mkdirSync, existsSync, readFileSync, unlinkSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "./schema";

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

// ─── Resolved paths ─────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../drizzle");

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
    const expanded = explicit === "~" || explicit.startsWith("~/")
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

async function createPgClient(url: string): Promise<Database> {
  _driver = "pg";
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const pool = new Pool({
    connectionString: url,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  const db = drizzle(pool, { schema });

  // Run pending migrations
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

  return db;
}

// ─── PGlite (embedded PostgreSQL) ────────────────────────────────────────────

/**
 * Clear a stale postmaster.pid before opening pglite. PGlite WASM can
 * abort during startup (migration crash, sigkill, OOM) without cleaning
 * up its own lock file — and the next boot then refuses to open the
 * data dir at all. The lock is process-local; if no live process is
 * holding it, removing it is safe.
 *
 * We detect "stale" two ways:
 *   1. The PID line in the file points at a process that no longer
 *      exists (the normal Postgres convention).
 *   2. The PID is pglite's sentinel value -42 — it never refers to a
 *      real process and is always a previous crash that didn't unwind.
 */
function clearStalePgliteLock(dataDir: string): void {
  const lockPath = join(dataDir, "postmaster.pid");
  if (!existsSync(lockPath)) return;
  let pid: number | null = null;
  try {
    const contents = readFileSync(lockPath, "utf8");
    const firstLine = contents.split("\n", 1)[0]?.trim();
    pid = firstLine ? Number.parseInt(firstLine, 10) : null;
  } catch {
    // Can't read — treat as stale and remove.
  }

  const isPgliteSentinel = pid === -42 || pid === 0;
  let processAlive = false;
  if (!isPgliteSentinel && pid && Number.isFinite(pid) && pid > 0) {
    try {
      process.kill(pid, 0); // signal 0 = liveness check
      processAlive = true;
    } catch {
      processAlive = false;
    }
  }

  if (!processAlive) {
    try {
      unlinkSync(lockPath);
      console.warn(
        `[db] removed stale pglite lock at ${lockPath} (pid=${pid ?? "unknown"})`,
      );
    } catch (err) {
      console.warn(
        `[db] failed to remove stale pglite lock at ${lockPath}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
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
  clearStalePgliteLock(dataDir);

  const client = new PGlite(dataDir);
  const db = drizzle(client, { schema });

  // Run pending migrations
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

  return db;
}

// ─── Singleton export ────────────────────────────────────────────────────────

export const db = await createDb();
