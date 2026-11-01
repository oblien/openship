import { expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

it("upgrades an applied 0182 with existing reservations and commands through 0183", async () => {
  const migrations = fileURLToPath(new URL("../drizzle/", import.meta.url));
  const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const entries = journal.entries.filter((entry) => entry.idx <= 182);
  const prefix = mkdtempSync(join(tmpdir(), "cloud-build-0182-"));
  const client = new PGlite("memory://");
  const db = drizzle(client);
  try {
    mkdirSync(join(prefix, "meta"));
    writeFileSync(join(prefix, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
    for (const entry of entries)
      copyFileSync(join(migrations, `${entry.tag}.sql`), join(prefix, `${entry.tag}.sql`));
    await migrate(db, { migrationsFolder: prefix });
    expect(
      (
        await client.query(`SELECT column_name FROM information_schema.columns
      WHERE table_name = 'cloud_build_activity' AND column_name = 'exclusive_preparation'`)
      ).rows,
    ).toEqual([]);
    await client.exec(`INSERT INTO organization (id, name) VALUES ('org', 'Owner');
      INSERT INTO cloud_workspace (id, organization_id, name) VALUES ('workspace', 'org', 'Cloud');
      INSERT INTO cloud_build_activity (deployment_id, project_id, workspace_id, organization_id, resources)
        VALUES ('pending', 'project', 'workspace', 'org', '{"cpuCores":1,"memoryMb":1024}');
      INSERT INTO cloud_build_activity (deployment_id, project_id, workspace_id, organization_id,
        provider_workspace_id, owner_token, started_at, commands)
        VALUES ('running', 'project2', 'workspace', 'org', 'vm', 'owner', now(), '[{"workspaceId":"vm","marker":"command"}]');`);

    await migrate(db, { migrationsFolder: migrations });
    await migrate(db, { migrationsFolder: migrations });
    expect(
      (
        await client.query(`SELECT deployment_id, exclusive_preparation, owner_token, resources, commands
      FROM cloud_build_activity ORDER BY deployment_id`)
      ).rows,
    ).toEqual([
      {
        deployment_id: "pending",
        exclusive_preparation: false,
        owner_token: null,
        resources: { cpuCores: 1, memoryMb: 1024 },
        commands: [],
      },
      {
        deployment_id: "running",
        exclusive_preparation: false,
        owner_token: "owner",
        resources: null,
        commands: [{ workspaceId: "vm", marker: "command" }],
      },
    ]);
    await client.exec(
      "UPDATE cloud_build_activity SET exclusive_preparation = true WHERE deployment_id = 'pending'",
    );
    expect(
      (
        await client.query(
          "SELECT exclusive_preparation FROM cloud_build_activity WHERE deployment_id = 'pending'",
        )
      ).rows,
    ).toEqual([{ exclusive_preparation: true }]);
  } finally {
    await client.close();
    rmSync(prefix, { recursive: true, force: true });
  }
});
