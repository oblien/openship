import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("migrates client registrations without reusing old grants or changing account identities", async () => {
  const db = new PGlite();
  const orm = drizzle(db);
  const migrations = fileURLToPath(new URL("../drizzle/", import.meta.url));
  const journal = JSON.parse(await readFile(join(migrations, "meta/_journal.json"), "utf8"));
  const entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 218);
  const prefix = await mkdtemp(join(tmpdir(), "oauth-provider-0218-"));
  try {
    await mkdir(join(prefix, "meta"));
    await writeFile(join(prefix, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
    for (const entry of entries)
      await copyFile(join(migrations, `${entry.tag}.sql`), join(prefix, `${entry.tag}.sql`));
    await migrate(orm, { migrationsFolder: prefix });
    await db.exec(`
      INSERT INTO "user" (id, name, email) VALUES ('user-1', 'Owner', 'owner@example.test');
      INSERT INTO account (id, user_id, provider_id, account_id)
        VALUES ('account-1', 'user-1', 'oidc', '["https://idp.example/", "subject-1"]');
      INSERT INTO oauth_application (
        id, client_id, client_secret, disabled, name, icon, metadata, user_id,
        redirect_urls, type, created_at, updated_at
      ) VALUES
        ('a', 'public-client', NULL, false, 'Native client', NULL, '{"label":"kept"}', 'user-1',
         'http://127.0.0.1:4321/callback,http://localhost:4321/callback', 'public', now(), now()),
        ('b', 'confidential-client', 'existing-sha256-hash', true, 'Web client', NULL, NULL, NULL,
         'https://client.example/callback', 'web', now(), now());
      INSERT INTO oauth_access_token (
        id, access_token, refresh_token, access_token_expires_at, refresh_token_expires_at,
        client_id, user_id, scopes
      ) VALUES ('old', 'legacy-access-token', 'legacy-refresh-token',
        now() + interval '1 day', now() + interval '30 days', 'public-client', 'user-1', 'openid');
    `);
    const migration = await readFile(
      new URL("../drizzle/0219_oauth_provider.sql", import.meta.url),
      "utf8",
    );
    await migrate(orm, { migrationsFolder: migrations });
    await migrate(orm, { migrationsFolder: migrations });
    expect(
      (
        await db.query(`SELECT client_id, client_secret, disabled, redirect_uris,
      token_endpoint_auth_method, require_pkce FROM oauth_client ORDER BY client_id`)
      ).rows,
    ).toEqual([
      {
        client_id: "confidential-client",
        client_secret: "existing-sha256-hash",
        disabled: true,
        redirect_uris: ["https://client.example/callback"],
        token_endpoint_auth_method: "client_secret_basic",
        require_pkce: true,
      },
      {
        client_id: "public-client",
        client_secret: null,
        disabled: false,
        redirect_uris: ["http://127.0.0.1:4321/callback", "http://localhost:4321/callback"],
        token_endpoint_auth_method: "none",
        require_pkce: true,
      },
    ]);
    expect(
      (await db.query("SELECT metadata FROM oauth_client WHERE client_id = 'public-client'")).rows,
    ).toEqual([{ metadata: { label: "kept" } }]);
    for (const table of [
      "oauth_refresh_token",
      "oauth_provider_access_token",
      "oauth_provider_consent",
      "mcp_oauth_token",
    ]) {
      expect((await db.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
    }
    expect(
      (await db.query("SELECT id, access_token, refresh_token FROM oauth_access_token")).rows,
    ).toEqual([
      { id: "old", access_token: "legacy-access-token", refresh_token: "legacy-refresh-token" },
    ]);
    expect((await db.query("SELECT id, provider_id, account_id FROM account")).rows).toEqual([
      { id: "account-1", provider_id: "oidc", account_id: '["https://idp.example/", "subject-1"]' },
    ]);
    expect(
      (
        await db.query(`SELECT access_token_expires_at <= now() AS access_expired,
      refresh_token_expires_at <= now() AS refresh_expired FROM oauth_access_token`)
      ).rows,
    ).toEqual([{ access_expired: true, refresh_expired: true }]);
    await db.exec(
      "UPDATE oauth_client SET disabled = true, name = 'Updated' WHERE client_id = 'public-client'",
    );
    await db.exec(migration);
    expect(
      (await db.query("SELECT disabled, name FROM oauth_client WHERE client_id = 'public-client'"))
        .rows,
    ).toEqual([{ disabled: true, name: "Updated" }]);
  } finally {
    await db.close();
    await rm(prefix, { recursive: true, force: true });
  }
});
