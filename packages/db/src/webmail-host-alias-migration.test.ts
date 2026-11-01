import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const migration = readFileSync(
  new URL("../drizzle/0198_webmail_host_alias.sql", import.meta.url),
  "utf8",
);

interface ServiceRow {
  id: string;
  advanced: unknown;
  updated_at: Date;
  [key: string]: unknown;
}

it("repairs older local managed webmail without rewriting other service configuration", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE servers (id text PRIMARY KEY, organization_id text, workspace_id text);
      CREATE TABLE project (
        id text PRIMARY KEY, organization_id text, server_id text, app_template_id text,
        deleted_at timestamp, deletion_in_progress boolean DEFAULT false
      );
      CREATE TABLE mail_servers (server_id text PRIMARY KEY, domain text, webmail_project_id text);
      CREATE TABLE service (
        id text PRIMARY KEY, project_id text, name text, advanced jsonb,
        environment jsonb DEFAULT '{"SESSION_ENCRYPTION_KEY":"encrypted-value"}',
        volumes jsonb DEFAULT '["data:/data"]', image text DEFAULT 'custom/webmail:stable',
        updated_at timestamp DEFAULT '2026-10-10 12:00:00'
      );
      INSERT INTO servers (id, organization_id) VALUES ('mail', 'owner'), ('other', 'owner'), ('foreign', 'someone-else');
      INSERT INTO servers VALUES ('cloud-host', 'owner', 'cloud-space');
      INSERT INTO project (id, organization_id, server_id, app_template_id) VALUES
        ('legacy', 'owner', 'mail', 'webmail'),
        ('null-config', 'owner', 'mail', 'webmail'),
        ('json-null-config', 'owner', 'mail', 'webmail'),
        ('null-hosts', 'owner', 'mail', 'webmail'),
        ('invalid-config', 'owner', 'mail', 'webmail'),
        ('invalid-hosts', 'owner', 'mail', 'webmail'),
        ('custom-host', 'owner', 'mail', 'webmail'),
        ('mixed-case', 'owner', 'mail', 'webmail'),
        ('full-hosts', 'owner', 'mail', 'webmail'),
        ('external', 'owner', 'mail', 'webmail'),
        ('cloud', 'owner', 'other', 'webmail'),
        ('cloud-cohost', 'owner', 'cloud-host', 'webmail'),
        ('foreign', 'owner', 'foreign', 'webmail'),
        ('unrelated', 'owner', 'mail', 'wordpress'),
        ('deleting', 'owner', 'mail', 'webmail'),
        ('deleted', 'owner', 'mail', 'webmail');
      UPDATE project SET deletion_in_progress = true WHERE id = 'deleting';
      UPDATE project SET deleted_at = now() WHERE id = 'deleted';
      INSERT INTO mail_servers VALUES ('mail', 'example.test', 'legacy');
      INSERT INTO service (id, project_id, name, advanced) VALUES
        ('legacy', 'legacy', 'webmail', '{"readiness":{"stabilization":true,"onFailure":"fail"},"extraHosts":{"private.example.test":"10.0.0.2"}}'),
        ('sibling', 'legacy', 'postgres', null),
        ('null-config', 'null-config', 'webmail', null),
        ('json-null-config', 'json-null-config', 'webmail', 'null'),
        ('null-hosts', 'null-hosts', 'webmail', '{"extraHosts":null,"resources":{"memoryMb":512}}'),
        ('invalid-config', 'invalid-config', 'webmail', '[]'),
        ('invalid-hosts', 'invalid-hosts', 'webmail', '{"extraHosts":[]}'),
        ('custom-host', 'custom-host', 'webmail', '{"extraHosts":{"mail.example.test":"10.0.0.9"}}'),
        ('mixed-case', 'mixed-case', 'webmail', '{"extraHosts":{"MAIL.EXAMPLE.TEST":"10.0.0.8"}}'),
        ('full-hosts', 'full-hosts', 'webmail', jsonb_build_object('extraHosts',
          (SELECT jsonb_object_agg('alias-' || n || '.example.test', '10.0.0.2') FROM generate_series(1, 100) AS n))),
        ('external', 'external', 'webmail', null),
        ('cloud', 'cloud', 'webmail', null),
        ('cloud-cohost', 'cloud-cohost', 'webmail', null),
        ('foreign', 'foreign', 'webmail', null),
        ('unrelated', 'unrelated', 'webmail', null),
        ('deleting', 'deleting', 'webmail', null),
        ('deleted', 'deleted', 'webmail', null);
    `);
    const before = (await db.query<ServiceRow>("SELECT * FROM service ORDER BY id")).rows;

    for (const projectId of [
      "legacy",
      "null-config",
      "json-null-config",
      "null-hosts",
      "invalid-config",
      "invalid-hosts",
      "custom-host",
      "mixed-case",
      "full-hosts",
      "cloud",
      "unrelated",
      "deleting",
      "deleted",
    ]) {
      await db.query("UPDATE mail_servers SET webmail_project_id = $1 WHERE server_id = 'mail'", [
        projectId,
      ]);
      await db.exec(migration);
    }
    await db.exec(
      "INSERT INTO mail_servers VALUES ('foreign', 'example.test', 'foreign'), ('cloud-host', 'example.test', 'cloud-cohost')",
    );
    await db.exec(migration);

    const after = (await db.query<ServiceRow>("SELECT * FROM service ORDER BY id")).rows;
    const repaired = new Set(["legacy", "null-config", "json-null-config", "null-hosts"]);
    for (const previous of before) {
      const next = after.find((row) => row.id === previous.id)!;
      if (!repaired.has(previous.id)) {
        expect(next).toEqual(previous);
        continue;
      }
      const advanced = (previous.advanced ?? {}) as Record<string, unknown>;
      expect(next).toEqual({
        ...previous,
        advanced: {
          ...advanced,
          extraHosts: {
            ...((advanced.extraHosts ?? {}) as Record<string, string>),
            "mail.example.test": "host-gateway",
          },
        },
        updated_at: expect.any(Date),
      });
      expect(next.updated_at.getTime()).toBeGreaterThan(previous.updated_at.getTime());
    }
    await db.exec("UPDATE mail_servers SET webmail_project_id = 'legacy' WHERE server_id = 'mail'");
    await db.exec(migration);
    expect((await db.query<ServiceRow>("SELECT * FROM service ORDER BY id")).rows).toEqual(after);
  } finally {
    await db.close();
  }
});
