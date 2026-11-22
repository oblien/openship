import { expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

it("upgrades existing GitHub identities and isolates provider and tenant keys", async () => {
  const migrations = fileURLToPath(new URL("../drizzle/", import.meta.url));
  const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const cutoff = journal.entries.findIndex((entry) => entry.tag === "0233_git_provider_previews");
  expect(cutoff).toBeGreaterThan(0);
  const entries = journal.entries.slice(0, cutoff);
  const prefix = mkdtempSync(join(tmpdir(), "git-provider-migration-"));
  const client = new PGlite("memory://");
  const db = drizzle(client);
  try {
    mkdirSync(join(prefix, "meta"));
    writeFileSync(join(prefix, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
    for (const entry of entries)
      copyFileSync(join(migrations, `${entry.tag}.sql`), join(prefix, `${entry.tag}.sql`));
    await migrate(db, { migrationsFolder: prefix });
    await client.exec(`
      INSERT INTO organization (id, name) VALUES ('org', 'Owner'), ('other', 'Other');
      INSERT INTO project_app (id, organization_id, name, slug) VALUES ('app', 'org', 'App', 'app');
      INSERT INTO project (id, organization_id, app_id, name, slug, webhook_id, webhook_secret)
        VALUES ('project', 'org', 'app', 'App', 'app', 123, 'encrypted');
      INSERT INTO action_workflow (id, organization_id, name, path, ref, source, definition, runner_ids, authority, secrets)
        VALUES ('workflow', 'org', 'CI', '.openship/workflows/ci.yml', 'main', 'reviewed source', '{}', '[]', '{}', '{"TOKEN":"encrypted"}');
      INSERT INTO cloud_webhook_binding (id, organization_id, cloud_project_id, git_owner, git_repo, webhook_id, webhook_secret)
        VALUES ('binding', 'org', 'project', 'owner', 'repo', 456, 'encrypted');
      INSERT INTO pull_request_preview (id, organization_id, source_project_id, owner, repo, number)
        VALUES ('preview', 'org', 'project', 'owner', 'repo', 1);
    `);
    await migrate(db, { migrationsFolder: migrations });
    await migrate(db, { migrationsFolder: migrations });
    expect(
      (await client.query("SELECT webhook_id, webhook_secret FROM project WHERE id='project'"))
        .rows,
    ).toEqual([{ webhook_id: "123", webhook_secret: "encrypted" }]);
    expect(
      (
        await client.query(
          "SELECT git_provider, source, secrets FROM action_workflow WHERE id='workflow'",
        )
      ).rows,
    ).toEqual([
      { git_provider: "github", source: "reviewed source", secrets: { TOKEN: "encrypted" } },
    ]);
    expect(
      (
        await client.query(
          "SELECT git_provider, webhook_id, webhook_secret FROM cloud_webhook_binding WHERE id='binding'",
        )
      ).rows,
    ).toEqual([{ git_provider: "github", webhook_id: "456", webhook_secret: "encrypted" }]);
    expect(
      (await client.query("SELECT provider FROM pull_request_preview WHERE id='preview'")).rows,
    ).toEqual([{ provider: "github" }]);
    // Same repository/branch and opaque ID can belong to separate providers or tenants.
    await client.exec(`
      INSERT INTO cloud_webhook_binding (id, organization_id, cloud_project_id, git_provider, git_owner, git_repo, webhook_id)
        VALUES ('other-provider', 'org', 'project', 'fixture', 'owner', 'repo', 'hook:abc'),
          ('other-tenant', 'other', 'other-project', 'github', 'owner', 'repo', '456');
      INSERT INTO pull_request_preview (id, organization_id, source_project_id, provider, owner, repo, number)
        VALUES ('other-preview', 'org', 'project', 'fixture', 'owner', 'repo', 1);
    `);
    await expect(
      client.exec(`INSERT INTO cloud_webhook_binding (id, organization_id, cloud_project_id, git_owner, git_repo)
      VALUES ('duplicate', 'org', 'project', 'owner', 'repo')`),
    ).rejects.toThrow(/unique/);
    await expect(
      client.exec(`INSERT INTO pull_request_preview (id, organization_id, source_project_id, owner, repo, number)
      VALUES ('duplicate-preview', 'org', 'project', 'owner', 'repo', 1)`),
    ).rejects.toThrow(/unique/);
    expect(
      (
        await client.query(
          "SELECT data_type FROM information_schema.columns WHERE table_name='deployment_check_run' AND column_name='check_run_id'",
        )
      ).rows,
    ).toEqual([{ data_type: "text" }]);
  } finally {
    await client.close();
    rmSync(prefix, { recursive: true, force: true });
  }
}, 60000);
