import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../schema";
import { createServerTunnelRepo } from "./server-tunnel.repo";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/**
 * Real (in-memory PGlite) test for the server_tunnels repo. The load-bearing
 * bit is `getByTarget`: it lets `saveTunnel` preserve a forward's configured
 * localPort/autoStart when a partial save (the "Open on localhost" affordance,
 * which sends only remotePort) would otherwise clobber them via upsert. FK
 * enforcement is disabled so we can insert without the server row.
 */
async function freshRepo() {
  const client = new PGlite("memory://");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  await client.exec("SET session_replication_role = replica;");
  return { client, repo: createServerTunnelRepo(db) };
}

describe("serverTunnel repo — getByTarget + upsert preservation", () => {
  let client: PGlite;
  let repo: Awaited<ReturnType<typeof freshRepo>>["repo"];
  beforeAll(async () => {
    ({ client, repo } = await freshRepo());
  });
  beforeEach(async () => {
    await client.exec("TRUNCATE server_tunnels;");
  });

  it("getByTarget finds a saved forward by (server, remotePort, remoteHost)", async () => {
    await repo.upsert({
      serverId: "srv1",
      remotePort: 3000,
      remoteHost: "127.0.0.1",
      localPort: 8080,
      autoStart: true,
    });

    const hit = await repo.getByTarget("srv1", 3000, "127.0.0.1");
    expect(hit?.localPort).toBe(8080);
    expect(hit?.autoStart).toBe(true);

    // A different port / host / server is a miss (upsert keys off this tuple).
    expect(await repo.getByTarget("srv1", 3001, "127.0.0.1")).toBeUndefined();
    expect(await repo.getByTarget("srv1", 3000, "10.0.0.5")).toBeUndefined();
    expect(await repo.getByTarget("srv2", 3000, "127.0.0.1")).toBeUndefined();
  });

  it("preserving config on a partial save keeps the same row + values", async () => {
    const created = await repo.upsert({
      serverId: "srv1",
      remotePort: 3000,
      remoteHost: "127.0.0.1",
      localPort: 8080,
      autoStart: true,
    });

    // Simulate the controller's partial-save path: read the existing row and
    // carry its localPort/autoStart into the upsert instead of resetting them.
    const existing = await repo.getByTarget("srv1", 3000, "127.0.0.1");
    const preserved = await repo.upsert({
      serverId: "srv1",
      remotePort: 3000,
      remoteHost: "127.0.0.1",
      localPort: existing!.localPort,
      autoStart: existing!.autoStart,
    });

    expect(preserved.id).toBe(created.id); // same row (upsert on the unique key)
    expect(preserved.localPort).toBe(8080);
    expect(preserved.autoStart).toBe(true);
  });

  it("a naive upsert (remotePort only) WOULD clobber — the bug the fix guards", async () => {
    await repo.upsert({
      serverId: "srv1",
      remotePort: 3000,
      remoteHost: "127.0.0.1",
      localPort: 8080,
      autoStart: true,
    });

    // What the old "Open" path effectively did: no localPort/autoStart carried.
    await repo.upsert({
      serverId: "srv1",
      remotePort: 3000,
      remoteHost: "127.0.0.1",
      localPort: null,
      autoStart: false,
    });

    const after = await repo.getByTarget("srv1", 3000, "127.0.0.1");
    expect(after?.localPort).toBeNull();
    expect(after?.autoStart).toBe(false);
  });
});
