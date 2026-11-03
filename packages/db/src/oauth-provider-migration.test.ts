import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("migrates client registrations without reusing old grants or changing account identities", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE "user" (id text PRIMARY KEY);
      CREATE TABLE "session" (id text PRIMARY KEY);
      CREATE TABLE account (id text PRIMARY KEY, provider_id text, account_id text);
      CREATE TABLE oauth_application (
        id text PRIMARY KEY, client_id text UNIQUE, client_secret text, disabled boolean,
        name text, icon text, metadata text, user_id text, redirect_urls text, type text,
        created_at timestamp, updated_at timestamp
      );
      CREATE TABLE oauth_access_token (id text PRIMARY KEY, access_token text, refresh_token text,
        access_token_expires_at timestamp DEFAULT (now() + interval '1 day'),
        refresh_token_expires_at timestamp DEFAULT (now() + interval '30 days'));
      INSERT INTO "user" VALUES ('user-1');
      INSERT INTO account VALUES ('account-1', 'oidc', '["https://idp.example/", "subject-1"]');
      INSERT INTO oauth_application VALUES
        ('a', 'public-client', NULL, false, 'Native client', NULL, '{"label":"kept"}', 'user-1',
         'http://127.0.0.1:4321/callback,http://localhost:4321/callback', 'public', now(), now()),
        ('b', 'confidential-client', 'existing-sha256-hash', true, 'Web client', NULL, NULL, NULL,
         'https://client.example/callback', 'web', now(), now());
      INSERT INTO oauth_access_token (id, access_token, refresh_token) VALUES ('old', 'legacy-access-token', 'legacy-refresh-token');
    `);
    const migration = await readFile(
      new URL("../drizzle/0219_oauth_provider.sql", import.meta.url),
      "utf8",
    );
    await db.exec(migration);
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
    expect((await db.query("SELECT * FROM account")).rows).toEqual([
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
  }
});
