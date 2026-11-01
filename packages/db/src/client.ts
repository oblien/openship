/** HTTP/CLI process composition. Native embedders import @repo/db/factory. */
import { createDatabase, PG_POOL_MAX, type DatabaseOptions } from "./connection";
import { resolve } from "node:path";
import { createEncryption, DEFAULT_ENCRYPTION_SECRET } from "./encryption";
export { PG_POOL_MAX, type Database, type DatabaseTransaction, type Driver } from "./connection";
export { awaitPgReady } from "./pg-ready";

function resolvePgliteDataDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";

  const explicit = process.env.PGLITE_DATA_DIR;
  if (explicit) {
    if (explicit === "memory://") return explicit;
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


const url = resolveDatabaseUrl();
const options: DatabaseOptions = {
  driver: url.startsWith("postgres") ? "pg" : "pglite",
  url,
  dataDir: process.env.OPENSHIP_NATIVE === "true"
    ? resolvePgliteDataDir()
    : process.env.VITEST || process.env.NODE_ENV === "test" ? "memory://" : resolvePgliteDataDir(),
  migrationsDir: process.env.OPENSHIP_MIGRATIONS_DIR,
  migrations: process.env.OPENSHIP_DB_MIGRATIONS === "verify" ? "verify" : "apply",
  pgliteAssetsDir: process.env.OPENSHIP_PGLITE_ASSETS_DIR,
  connectTimeoutMs: process.env.OPENSHIP_DB_CONNECT_TIMEOUT_MS === undefined ? undefined : Number(process.env.OPENSHIP_DB_CONNECT_TIMEOUT_MS),
  registerExitHook: process.env.OPENSHIP_NATIVE !== "true",
  lockOwnerId: process.env.OPENSHIP_DB_LOCK_OWNER,
  lockWaitMs: process.env.OPENSHIP_NATIVE === "true" ? 0 : undefined,
  takeover: process.env.OPENSHIP_NATIVE !== "true" && (process.execArgv.includes("--watch") || process.env.OPENSHIP_DEV_LOCK_TAKEOVER === "true"),
};
export const storageEncryption = createEncryption(process.env.BETTER_AUTH_SECRET ?? DEFAULT_ENCRYPTION_SECRET);
const connection = await createDatabase(options).catch(error => {
  storageEncryption.close();
  throw error;
});
export const db = connection.db;
export async function closeDb(): Promise<void> {
  try { await connection.close(); }
  finally { storageEncryption.close(); }
}
export const getDriver = () => connection.driver;
export function getPgPool() {
  if (!connection.pool) throw new Error("Postgres pool is unavailable (active driver is not 'pg')");
  return connection.pool;
}
