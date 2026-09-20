import { mkdirSync, existsSync, readFileSync, unlinkSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import type { Pool } from "pg";
import * as schema from "./schema";
import { createPgliteLock } from "./pglite-lock";
import { awaitPgReady } from "./pg-ready";
import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";

/**
 * Unified database type - works regardless of driver (pg or PGlite).
 * Every repo and service receives this; they never know which driver runs beneath.
 */
export type Database = NodePgDatabase<typeof schema> | PgliteDatabase<typeof schema>;
/** Transaction handle shared by the Postgres and PGlite drivers. */
export type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Which driver is active - useful for conditional logic in adapters */
export type Driver = "pg" | "pglite";

export const PG_POOL_MAX = 20;

export interface DatabaseOptions {
  driver: Driver;
  url?: string;
  /** Explicit filesystem path or memory://. Required for PGlite. */
  dataDir?: string;
  migrationsDir?: string;
  /** apply owns migration writes; verify only accepts the schema shipped with this build. */
  migrations?: "apply" | "verify";
  pgliteAssetsDir?: string;
  poolMax?: number;
  connectTimeoutMs?: number;
  lockWaitMs?: number;
  /** Process-owner integration only; embedding applications normally leave both false. */
  takeover?: boolean;
  registerExitHook?: boolean;
  lockOwnerId?: string;
}

export interface DatabaseConnection {
  readonly db: Database;
  readonly driver: Driver;
  readonly pool: Pool | undefined;
  close(): Promise<void>;
}

/** Explicit resource acquisition. Importing the factory opens no connection or data directory. */
export async function createDatabase(input: DatabaseOptions): Promise<DatabaseConnection> {
  const options = Object.freeze({ ...input });
  if (options.driver !== "pg" && options.driver !== "pglite") throw new TypeError("Unknown database driver");
  if (options.driver === "pg" && !/^postgres(?:ql)?:\/\//.test(options.url ?? ""))
    throw new TypeError("A PostgreSQL connection URL is required");
  if (options.driver === "pglite" && (typeof options.dataDir !== "string" || !options.dataDir.trim()))
    throw new TypeError("An explicit PGlite dataDir or memory:// is required");
  if (options.poolMax !== undefined && (!Number.isSafeInteger(options.poolMax) || options.poolMax < 2))
    throw new TypeError("poolMax must be an integer of at least two");
  if (options.migrations !== undefined && options.migrations !== "apply" && options.migrations !== "verify")
    throw new TypeError("migrations must be apply or verify");
  let _driver: Driver = options.driver;
  let _pgPool: Pool | undefined;
  let _pgliteClient: { close(): Promise<void> } | undefined;
  let closing: Promise<void> | undefined;
  const lock = createPgliteLock({ registerExitHook: options.registerExitHook ?? false, ownerId: options.lockOwnerId });
  const MIGRATIONS_DIR = options.migrationsDir ?? resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle");

  async function verifySchema(db: Database): Promise<void> {
    const expected = readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR }).at(-1);
    if (!expected) throw new Error("The package contains no database migrations");
    try {
      const result = await db.execute(sql`select hash, created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`);
      const last = result.rows[0] as { hash?: string; created_at?: string | number } | undefined;
      if (last?.hash !== expected.hash || Number(last?.created_at) !== expected.folderMillis)
        throw new Error("The database schema does not match this Openship build");
    } catch (cause) {
      throw new Error("Database schema verification failed. Use a compatible build or explicitly apply migrations with the database owner.", { cause });
    }
  }

  function close(): Promise<void> {
    return closing ??= (async () => {
      if (_pgliteClient) {
        await _pgliteClient.close();
        _pgliteClient = undefined;
      }
      if (_pgPool) {
        await _pgPool.end();
        _pgPool = undefined;
      }
      lock.release();
    })().catch((error) => { closing = undefined; throw error; });
  }
  async function createPgClient(url: string): Promise<Database> {
    _driver = "pg";
    const { Pool } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const pool = new Pool({
      connectionString: url,
      max: options.poolMax ?? PG_POOL_MAX,
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
    await awaitPgReady(pool, { budgetMs: options.connectTimeoutMs });

    const db = drizzle(pool, { schema });

    // Run pending migrations
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    if (options.migrations === "verify") await verifySchema(db);
    else {
      // Serialize migrators across API/native owners that share a PostgreSQL database.
      const migrationLock = await pool.connect();
      try {
        await migrationLock.query("select pg_advisory_lock($1)", [0x6f73686d]);
        await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
      } finally {
        try { await migrationLock.query("select pg_advisory_unlock($1)", [0x6f73686d]); }
        finally { migrationLock.release(); }
      }
    }

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
    const dir = options.pgliteAssetsDir;
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

    if (options.dataDir === "memory://") {
      const assets = await resolvePgliteAssets();
      const client = assets ? new PGlite({ dataDir: "memory://", ...assets }) : new PGlite("memory://");
      _pgliteClient = client;
      const db = drizzle(client, { schema });
      if (options.migrations === "verify") await verifySchema(db);
      else await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
      return db;
    }
    const dataDir = resolve(options.dataDir!);
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
    await lock.acquire(dataDir, { waitMs: options.lockWaitMs ?? 30_000, pollMs: 250, takeover: options.takeover ?? false });
    clearStalePgliteControlFile(dataDir);

    const assets = await resolvePgliteAssets();
    const client = assets ? new PGlite({ dataDir, ...assets }) : new PGlite(dataDir);
    _pgliteClient = client;
    const db = drizzle(client, { schema });

    // Run pending migrations. Drizzle wraps each migration in a transaction and
    // the lock guarantees we're the only writer, so this is atomic and race-free.
    if (options.migrations === "verify") await verifySchema(db);
    else await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

    return db;
  }


  try {
    const db = options.driver === "pg" ? await createPgClient(options.url!) : await createPgliteClient();
    return Object.freeze({ db, driver: _driver, get pool() { return _pgPool; }, close });
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Database initialization and cleanup failed"); }
    throw error;
  }
}
