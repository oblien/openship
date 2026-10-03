import { afterAll, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as schema from "./schema";
import { createServerRepo } from "./repos/server.repo";
import { createDockerMigrationRunRepo } from "./repos/docker-migration.repo";

const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const directory = fileURLToPath(new URL("../drizzle/", import.meta.url));
afterAll(() => client.close());

it("upgrades existing SSH/managed projects and migration history without changing their destinations", async () => {
  const journal = JSON.parse(readFileSync(`${directory}/meta/_journal.json`, "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  for (const entry of journal.entries.filter(entry => entry.idx < 161))
    await client.exec(readFileSync(`${directory}/${entry.tag}.sql`, "utf8"));

  await db.insert(schema.organization).values([{ id: "org", name: "Owner" }, { id: "other", name: "Other" }]);
  await db.insert(schema.projectGroup).values({ id: "group", organizationId: "org", name: "Apps", slug: "apps" });
  await db.insert(schema.cloudWorkspace).values({ id: "workspace", organizationId: "org", name: "Managed" });
  // Raw inserts deliberately use the historical columns, before purpose/recovery exist.
  await client.query("INSERT INTO servers (id, organization_id, ssh_host) VALUES ($1, $2, $3)", ["ssh", "org", "203.0.113.1"]);
  await client.query("INSERT INTO servers (id, organization_id, workspace_id) VALUES ($1, $2, $3)", ["managed", "org", "workspace"]);
  for (const serverId of ["ssh", "managed"])
    await db.insert(schema.project).values({ id: `project-${serverId}`, organizationId: "org", groupId: "group", name: serverId, slug: serverId, environmentSlug: serverId, serverId });
  await client.query(
    "INSERT INTO docker_migration_run (id, organization_id, source_server_id, target_server_id, project_id, project_name, status, finished_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now())",
    ["historic-run", "org", "ssh", "managed", "project-managed", "Existing import", "succeeded"],
  );

  for (const entry of journal.entries.filter(entry => entry.idx >= 161))
    await client.exec(readFileSync(`${directory}/${entry.tag}.sql`, "utf8"));

  const inventory = createServerRepo(db);
  expect(await inventory.getInOrganization("ssh", "org")).toMatchObject({ purpose: "deployment", sshHost: "203.0.113.1", workspaceId: null });
  expect(await inventory.getInOrganization("managed", "org")).toMatchObject({ purpose: "deployment", workspaceId: "workspace" });
  expect(await client.query("SELECT id, server_id, workspace_id FROM project ORDER BY id")).toMatchObject({ rows: [
    { id: "project-managed", server_id: "managed", workspace_id: "workspace" },
    { id: "project-ssh", server_id: "ssh", workspace_id: null },
  ] });
  expect(await createDockerMigrationRunRepo(db).findById("historic-run")).toMatchObject({
    status: "succeeded", projectId: "project-managed", recovery: {},
  });
  expect(await inventory.listMigrationSources("org")).toEqual([]);

  // The upgraded database enforces the same source/tenant boundary as a fresh install.
  const source = await inventory.create({ organizationId: "org", purpose: "migration_source",
    sshHost: "203.0.113.2", sshHostKey: "fixture-host-key", sshAuthMethod: "key", sshPrivateKey: "fixture-encrypted-key" });
  expect((await inventory.listMigrationSources("org")).map(row => row.id)).toEqual([source.id]);
  expect(await inventory.listMigrationSources("other")).toEqual([]);
  await expect(db.insert(schema.project).values({ id: "forbidden", organizationId: "org", groupId: "group",
    name: "Forbidden destination", slug: "forbidden", environmentSlug: "forbidden", serverId: source.id })).rejects.toThrow();
  await expect(client.query("UPDATE project SET server_id = $1, workspace_id = NULL WHERE id = $2", ["ssh", "project-managed"])).rejects.toThrow("explicit migration");
  await expect(client.query("UPDATE servers SET purpose = $1 WHERE id = $2", ["migration_source", "managed"])).rejects.toThrow();
  expect(await client.query("SELECT server_id, workspace_id FROM project WHERE id = $1", ["project-managed"]))
    .toMatchObject({ rows: [{ server_id: "managed", workspace_id: "workspace" }] });
}, 30_000);
