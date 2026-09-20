import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../schema";
import { createOrganizationRepo } from "./organization.repo";

const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const orgs = createOrganizationRepo(db);
beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  await db.insert(schema.organization).values([
    { id: "org-a", name: "Customer A" }, { id: "org-b", name: "Customer B" },
  ]);
}, 30_000);
afterAll(async () => { await client.close(); });
describe("organization cloud ownership", () => {
  it("persists an immutable namespace and rejects a second owner", async () => {
    await orgs.setOblienNamespace("org-a", "ns-a");
    await orgs.setOblienNamespace("org-a", "ns-a");
    await expect(orgs.setOblienNamespace("org-a", "ns-other")).rejects.toThrow("cannot be reassigned");
    await expect(orgs.setOblienNamespace("org-b", "ns-a")).rejects.toThrow();
    expect((await orgs.findById("org-b"))?.oblienNamespace).toBeNull();
  });
  it("cannot apply an entitlement returned for a different namespace", async () => {
    await expect(orgs.setBillingEntitlement("org-a", "ns-b", {
      planTierId: "pro", subscriptionStatus: "active", currentPeriodStart: null, currentPeriodEnd: null,
    })).rejects.toThrow("namespace changed");
    expect((await orgs.findById("org-a"))?.planTierId).toBe("free");
  });
});
