import { expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

it("adds notification settings to an existing workflow without changing its source or credentials", async () => {
  const migrations = fileURLToPath(new URL("../drizzle/", import.meta.url));
  const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const cutoff = journal.entries.findIndex((entry) =>
    entry.tag.endsWith("_action_workflow_notifications"),
  );
  expect(cutoff).toBeGreaterThan(0);
  const entries = journal.entries.slice(0, cutoff);
  const prefix = mkdtempSync(join(tmpdir(), "actions-notification-migration-"));
  const client = new PGlite("memory://");
  const db = drizzle(client);
  try {
    mkdirSync(join(prefix, "meta"));
    writeFileSync(join(prefix, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
    for (const entry of entries)
      copyFileSync(join(migrations, `${entry.tag}.sql`), join(prefix, `${entry.tag}.sql`));
    await migrate(db, { migrationsFolder: prefix });
    await client.exec(`INSERT INTO organization (id, name) VALUES ('org', 'Owner');
      INSERT INTO action_workflow (id, organization_id, name, path, ref, source, definition, runner_ids, authority, secrets)
      VALUES ('workflow', 'org', 'CI', '.openship/workflows/ci.yml', 'main', 'reviewed source', '{}', '[]', '{}', '{"TOKEN":"encrypted"}');`);
    await migrate(db, { migrationsFolder: migrations });
    await migrate(db, { migrationsFolder: migrations });
    expect(
      (
        await client.query(
          "SELECT source, secrets, notifications FROM action_workflow WHERE id = 'workflow'",
        )
      ).rows,
    ).toEqual([
      { source: "reviewed source", secrets: { TOKEN: "encrypted" }, notifications: null },
    ]);
    await client.query("UPDATE action_workflow SET notifications = $1 WHERE id = 'workflow'", [
      JSON.stringify({ channels: ["ops"], events: ["failure"] }),
    ]);
    expect(
      (await client.query("SELECT notifications FROM action_workflow WHERE id = 'workflow'")).rows,
    ).toEqual([{ notifications: { channels: ["ops"], events: ["failure"] } }]);
  } finally {
    await client.close();
    rmSync(prefix, { recursive: true, force: true });
  }
}, 60000);
