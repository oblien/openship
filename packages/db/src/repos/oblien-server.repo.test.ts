import { afterAll, beforeAll, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import * as schema from "../schema";
import { createServerRepo } from "./server.repo";
import { createCredentialRepo } from "./credential.repo";

const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const servers = createServerRepo(db);
const credentials = createCredentialRepo(db);
beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  await db.insert(schema.organization).values([
    { id: "org-a", name: "A" },
    { id: "org-b", name: "B" },
  ]);
}, 90_000);
afterAll(() => client.close());
it("pins a single VM to its org and credential across retries and excludes it from SSH jobs", async () => {
  const grant = await credentials.create({
    organizationId: "org-a",
    provider: "oblien",
    name: "VM A",
    publicFields: { authorization: "oauth", vmId: "vm-a" },
    secretsEnc: "fixture-ciphertext",
  });
  const attach = () => servers.attachOblienVm("org-a", grant.id, "vm-a", "A");
  const [a, b] = await Promise.all([attach(), attach()]);
  expect(a.id).toBe(b.id);
  expect((await servers.getByOblienCredential("org-a", grant.id))?.id).toBe(a.id);
  expect(await servers.getByOblienCredential("org-b", grant.id)).toBeUndefined();
  await expect(servers.attachOblienVm("org-a", grant.id, "different-vm", "B")).rejects.toThrow();
  expect(await servers.getInOrganization(a.id, "org-b")).toBeUndefined();
  await expect(servers.attachOblienVm("org-b", grant.id, "vm-b", "B")).rejects.toThrow();
  await expect(credentials.remove("org-a", grant.id)).rejects.toThrow();
  expect(await servers.list()).toHaveLength(0);
  expect(await servers.listByOrganization("org-a", true)).toHaveLength(1);
  expect(await servers.listByOrganization("org-b", true)).toHaveLength(0);
});
