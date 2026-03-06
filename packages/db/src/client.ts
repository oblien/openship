import { mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "./schema";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Unified database type — works regardless of driver (pg or PGlite).
 * Every repo and service receives this; they never know which driver runs beneath.
 */
export type Database = NodePgDatabase<typeof schema> | PgliteDatabase<typeof schema>;

/** Which driver is active — useful for conditional logic in adapters */
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
 *   1) PGLITE_DATA_DIR env var — explicit path (recommended for self-hosted)
 *   2) Default: ~/.openship/data  (outside the project, won't be committed)
 */
function resolvePgliteDataDir(): string {
  const explicit = process.env.PGLITE_DATA_DIR;
  if (explicit) return resolve(explicit);

  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
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
async function createDb(): Promise<Database> {
  const url = process.env.DATABASE_URL ?? "";

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

async function createPgliteClient(): Promise<Database> {
  _driver = "pglite";
  const dataDir = resolvePgliteDataDir();
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite(dataDir);
  const db = drizzle(client, { schema });

  // Run pending migrations
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

  return db;
}

// ─── Singleton export ────────────────────────────────────────────────────────

export const db = await createDb();
