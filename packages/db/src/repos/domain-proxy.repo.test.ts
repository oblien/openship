import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "../schema";
import { createDomainRepo } from "./domain.repo";

const migrations = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

describe("domain proxy storage and additive upgrade (PGlite)", () => {
  const directory = mkdtempSync(join(tmpdir(), "openship-domain-proxy-"));
  let client: PGlite;
  let repo: ReturnType<typeof createDomainRepo>;

  beforeAll(async () => {
    // Upgrade a real legacy database rather than just creating the new schema.
    const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8"));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 203);
    mkdirSync(join(directory, "meta"));
    writeFileSync(join(directory, "meta/_journal.json"), JSON.stringify(journal));
    for (const entry of journal.entries)
      copyFileSync(join(migrations, `${entry.tag}.sql`), join(directory, `${entry.tag}.sql`));
    client = new PGlite("memory://");
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: directory });
    await client.exec("SET session_replication_role = replica");
    await client.exec(
      `INSERT INTO domain (id, project_id, hostname, target_port) VALUES ('legacy', 'project-a', 'legacy.example.test', 8080)`,
    );
    await migrate(db, { migrationsFolder: migrations });
    repo = createDomainRepo(db);
  });

  afterAll(async () => {
    await client?.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("leaves existing rows inheriting and preserves their owner and routing target", async () => {
    expect(await repo.findById("legacy")).toMatchObject({
      proxy: null,
      projectId: "project-a",
      hostname: "legacy.example.test",
      targetPort: 8080,
    });
    const column = await client.query<{ is_nullable: string; column_default: string | null }>(
      "SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name = 'domain' AND column_name = 'proxy'",
    );
    expect(column.rows).toEqual([{ is_nullable: "YES", column_default: null }]);
  });

  it("persists explicit caps across reads, omitted updates, replacement, and reset", async () => {
    const row = await repo.create({
      projectId: "project-a",
      hostname: "explicit.example.test",
      proxy: { clientMaxBodySize: "2m" },
    });
    expect(row.proxy).toEqual({ clientMaxBodySize: "2m" });
    await repo.update(row.id, { targetPort: 9090 });
    expect((await repo.findByHostnameForProject("project-a", row.hostname))?.proxy).toEqual({
      clientMaxBodySize: "2m",
    });
    await repo.update(row.id, { proxy: { clientMaxBodySize: "0" } });
    expect(
      (await repo.listByProject("project-a")).find((domain) => domain.id === row.id)?.proxy,
    ).toEqual({ clientMaxBodySize: "0" });
    expect(
      (await repo.listByProjects(["project-a"]))
        .get("project-a")
        ?.find((domain) => domain.id === row.id)?.proxy,
    ).toEqual({ clientMaxBodySize: "0" });
    expect(await repo.findByHostnameForProject("project-b", row.hostname)).toBeUndefined();
    await repo.update(row.id, { proxy: null });
    expect(await repo.findById(row.id)).toMatchObject({
      proxy: null,
      projectId: "project-a",
      targetPort: 9090,
    });
    expect(
      (await repo.create({ projectId: "project-a", hostname: "inherited.example.test" })).proxy,
    ).toBeNull();
  });
});
