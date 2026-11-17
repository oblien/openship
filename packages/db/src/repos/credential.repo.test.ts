import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import * as schema from "../schema";
import { createCredentialRepo, type Credential } from "./credential.repo";

const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const repo = createCredentialRepo(db);
let stored: Credential;
beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
});
afterAll(() => client.close());
beforeEach(async () => {
  await db.delete(schema.credential);
  await db.delete(schema.organization);
  await db.insert(schema.organization).values([
    { id: "org-a", name: "A" },
    { id: "org-b", name: "B" },
  ]);
  stored = await repo.create({
    organizationId: "org-a",
    provider: "docker-registry",
    name: "Production",
    selector: "ghcr.io",
    publicFields: { username: "owner" },
    secretsEnc: "encrypted-old",
  });
});

describe("credential verification observations", () => {
  it("records a redacted rejection and a subsequent successful recheck", async () => {
    await repo.recordVerification(stored, { ok: false, reason: "Login rejected" });
    const invalid = (await repo.findById("org-a", stored.id))!;
    expect(invalid).toMatchObject({ status: "invalid", lastError: "Login rejected" });
    await repo.recordVerification(invalid, { ok: true });
    expect(await repo.findById("org-a", stored.id)).toMatchObject({
      status: "active",
      lastError: null,
      lastVerifiedAt: expect.any(Date),
    });
  });

  it.each([
    { secretsEnc: "encrypted-replacement" },
    { selector: "registry.example.com" },
    { publicFields: { username: "replacement" } },
  ])("ignores an old rejection after authentication settings change: %j", async (patch) => {
    await repo.update("org-a", stored.id, patch);
    await repo.recordVerification(stored, { ok: false, reason: "Old login rejected" });
    expect(await repo.findById("org-a", stored.id)).toMatchObject({
      ...patch,
      status: "active",
      lastError: null,
    });
  });

  it("does not let an earlier success overwrite a newer invalidation", async () => {
    await repo.markInvalid("org-a", stored.id, "Revoked");
    await repo.recordVerification(stored, { ok: true });
    expect(await repo.findById("org-a", stored.id)).toMatchObject({
      status: "invalid",
      lastError: "Revoked",
    });
  });

  it("cannot change a row in another organization", async () => {
    await repo.recordVerification({ ...stored, organizationId: "org-b" }, { ok: false });
    expect(await repo.findById("org-a", stored.id)).toMatchObject({ status: "active" });
  });

  it("does not recreate a credential removed while verification was in flight", async () => {
    await repo.remove("org-a", stored.id);
    await repo.recordVerification(stored, { ok: false });
    expect(await repo.listByOrg("org-a")).toEqual([]);
  });
});
