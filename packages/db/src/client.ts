import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import * as schema from "./schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type Database = NodePgDatabase<typeof schema>;

/** Which driver is active — useful for conditional logic in adapters */
export type Driver = "pg" | "pglite";

// ─── Internal state ──────────────────────────────────────────────────────────

let _driver: Driver;

export function getDriver(): Driver {
  return _driver;
}

// ─── Migration paths ─────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../drizzle");

// ─── Client factory ──────────────────────────────────────────────────────────

/**
 * Creates and returns a typed Drizzle database instance.
 *
 * Driver selection based on DATABASE_URL:
 *   postgres://...  → node-postgres Pool  (production / Docker self-host)
 *   empty or path   → PGlite embedded     (zero-config dev, no Docker)
 *
 * Migrations run automatically at startup from `packages/db/drizzle/`.
 * Schema changes → `pnpm db:generate` → commit the new migration → restart.
 */
async function createDb(): Promise<Database> {
  const url = process.env.DATABASE_URL ?? "";

  if (url.startsWith("postgres")) {
    return createPgClient(url);
  }

  return createPgliteClient(url);
}

// ─── PostgreSQL (node-postgres) ──────────────────────────────────────────────

async function createPgClient(url: string): Promise<Database> {
  _driver = "pg";
  const { Pool } = await import("pg");
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

async function createPgliteClient(url: string): Promise<Database> {
  _driver = "pglite";
  const dataDir = url || "./data/pglite";
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle: pgliteDrizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite(dataDir);
  const db = pgliteDrizzle(client, { schema });

  // Run pending migrations
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

  // Cast to shared Database type — both use the same PostgreSQL dialect
  return db as unknown as Database;
}

// ─── Singleton export ────────────────────────────────────────────────────────

export const db = await createDb();
