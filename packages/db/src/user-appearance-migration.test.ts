import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { createDatabase } from "./connection";
import { createSettingsRepo } from "./repos/settings.repo";
import * as schema from "./schema";
import { createTheme, defaultAppearance } from "@repo/core";
it("upgrades old users idempotently without changing their preferences", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      "CREATE TABLE user_settings (user_id text PRIMARY KEY, cloud_session_token text); INSERT INTO user_settings VALUES ('old', 'keep');",
    );
    const sql = await readFile(
      new URL("../drizzle/0193_user_appearance.sql", import.meta.url),
      "utf8",
    );
    await db.exec(sql);
    await db.exec(sql);
    expect((await db.query("SELECT * FROM user_settings")).rows).toEqual([
      { user_id: "old", cloud_session_token: "keep", appearance: null },
    ]);
  } finally {
    await db.close();
  }
});
it("atomically saves only the caller's appearance alongside existing credentials", async () => {
  const connection = await createDatabase({ driver: "pglite", dataDir: "memory://" });
  try {
    const db = connection.db;
    const repo = createSettingsRepo(db);
    for (const id of ["alice", "bob"])
      await db
        .insert(schema.user)
        .values({ id, name: id, email: `${id}@example.test`, emailVerified: true });
    await repo.setCloudSession("alice", "encrypted-credential");
    const appearance = {
      ...defaultAppearance("personal"),
      themes: [createTheme("dim", "personal", "Personal")],
    };
    await repo.setAppearance("alice", appearance);
    await repo.setAppearance("bob", defaultAppearance("dark"));
    expect(await repo.getAppearance("alice")).toEqual(appearance);
    expect(await repo.update("alice", { buildMode: "local" })).not.toHaveProperty("appearance");
    expect(
      await repo.upsert({ id: "ignored", userId: "alice", buildMode: "server" }),
    ).not.toHaveProperty("appearance");
    expect(await repo.getAppearance("alice")).toEqual(appearance);
    expect(await repo.findByUser("alice")).not.toHaveProperty("appearance");
    expect(await repo.findByUser("alice")).toMatchObject({
      cloudSessionToken: "encrypted-credential",
    });
    expect(await repo.getAppearance("bob")).toEqual(defaultAppearance("dark"));
    expect(await repo.findByUser("bob")).toMatchObject({ cloudSessionToken: null });
    await repo.setAppearance("alice", null);
    expect(await repo.getAppearance("alice")).toBeNull();
    expect(await repo.findByUser("alice")).toMatchObject({
      cloudSessionToken: "encrypted-credential",
    });
  } finally {
    await connection.close();
  }
}, 30_000);
