import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import type { NativeClusterConfig } from "@repo/core";
import * as schema from "../schema";
import { createServerClusterRepo } from "./server-cluster.repo";

const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const repo = createServerClusterRepo(db);
const config = (): NativeClusterConfig => ({
  name: "Production",
  network: { mode: "native", cidrs: ["10.0.0.0/24"], mtu: 1400, probePort: 51821 },
  members: [
    { serverId: "s1", providerId: "custom", privateIp: "10.0.0.1" },
    { serverId: "s2", providerId: "hetzner-cloud", privateIp: "10.0.0.2" },
  ],
});

beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
}, 30_000);
afterAll(async () => {
  await client.close();
});
beforeEach(async () => {
  await db.delete(schema.serverCluster);
  await db.delete(schema.servers);
  await db.delete(schema.organization);
  await db.insert(schema.organization).values([
    { id: "org-a", name: "A" },
    { id: "org-b", name: "B" },
  ]);
  await db
    .insert(schema.servers)
    .values(["s1", "s2", "s3", "s4"].map((id) => ({ id, organizationId: "org-a", sshHost: id })));
  await db
    .insert(schema.servers)
    .values({ id: "foreign", organizationId: "org-b", sshHost: "foreign" });
});

describe("cluster persistence", () => {
  it("creates atomically and reuses a retried creation request", async () => {
    const first = await repo.create("org-a", config(), "request-a", "hash-a");
    const retry = await repo.create("org-a", config(), "request-a", "hash-a");
    expect(retry.id).toBe(first.id);
    expect(retry.members).toHaveLength(2);
    expect(retry.network.ownership).toBe("external");
    await expect(repo.create("org-a", config(), "request-a", "different")).rejects.toMatchObject({
      code: "CLUSTER_CONFLICT",
    });
    expect(await repo.list("org-a")).toHaveLength(1);
  });
  it("keeps references inside the organization and rolls back failed enrollment", async () => {
    const value = config();
    value.members[1]!.serverId = "foreign";
    await expect(repo.create("org-a", value, "request-a", "hash-a")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await repo.list("org-a")).toHaveLength(0);
    const cluster = await repo.create("org-a", config(), "request-a", "hash-a");
    await expect(repo.get("org-b", cluster.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repo.remove("org-b", cluster.id, 1)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await repo.list("org-b")).toHaveLength(0);
  });
  it("allows only one active cluster per server and protects enrolled servers from deletion", async () => {
    await repo.create("org-a", config(), "request-a", "hash-a");
    await expect(repo.create("org-a", config(), "request-b", "hash-b")).rejects.toMatchObject({
      code: "CLUSTER_CONFLICT",
    });
    await expect(db.delete(schema.servers).where(eq(schema.servers.id, "s1"))).rejects.toThrow();
    expect(await repo.list("org-a")).toHaveLength(1);
  });
  it("rejects stale edits and invalidates verification when membership changes", async () => {
    const cluster = await repo.create("org-a", config(), "request-a", "hash-a");
    const { run } = await repo.startVerification("org-a", cluster.id, 1, "user");
    await expect(repo.update("org-a", cluster.id, 1, config())).rejects.toThrow("running");
    await repo.finish(run.id, { stage: "complete", hosts: [], peers: [] }, false, "Failed");
    const value = config();
    value.members[1]!.serverId = "s3";
    const updated = await repo.update("org-a", cluster.id, 1, value);
    expect(updated.revision).toBe(2);
    expect(updated.verification).toBeNull();
    expect(await repo.membership("s2")).toBeNull();
    await expect(repo.update("org-a", cluster.id, 1, config())).rejects.toThrow("changed");
  });
  it("deduplicates active verification and recovers an interrupted worker without accepting its late result", async () => {
    const cluster = await repo.create("org-a", config(), "request-a", "hash-a");
    const first = await repo.startVerification("org-a", cluster.id, 1, "user");
    const duplicate = await repo.startVerification("org-a", cluster.id, 1, "user");
    expect(duplicate.created).toBe(false);
    expect(duplicate.run.id).toBe(first.run.id);
    await db
      .update(schema.clusterVerification)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(schema.clusterVerification.id, first.run.id));
    expect((await repo.get("org-a", cluster.id)).verification?.status).toBe("interrupted");
    expect(await repo.progress(first.run.id, first.run.report)).toBe(false);
    await repo.finish(first.run.id, first.run.report, true, null);
    const retry = await repo.startVerification("org-a", cluster.id, 1, "user");
    expect(retry.created).toBe(true);
    expect(retry.run.id).not.toBe(first.run.id);
    expect((await repo.get("org-a", cluster.id)).verification?.status).toBe("running");
  });
  it("detects physical-host aliases across clusters and fences identity changes", async () => {
    const a = await repo.create("org-a", config(), "request-a", "hash-a");
    const value = config();
    value.members = value.members.map((m, i) => ({ ...m, serverId: `s${i + 3}` }));
    const b = await repo.create("org-a", value, "request-b", "hash-b");
    const runA = await repo.startVerification("org-a", a.id, 1, "user");
    const runB = await repo.startVerification("org-a", b.id, 1, "user");
    await repo.recordIdentity(a.id, "s1", "host:identity", runA.run.id);
    await expect(repo.recordIdentity(b.id, "s3", "host:identity", runB.run.id)).rejects.toThrow(
      "already enrolled",
    );
    await expect(repo.recordIdentity(a.id, "s1", "host:replaced", runA.run.id)).rejects.toThrow(
      "identity changed",
    );
    await repo.finish(runA.run.id, runA.run.report, false, "Failed");
    await expect(repo.recordIdentity(a.id, "s2", "host:two", runA.run.id)).rejects.toThrow(
      "no longer active",
    );
  });
  it("removes adopted cluster records while keeping customer servers", async () => {
    const cluster = await repo.create("org-a", config(), "request-a", "hash-a");
    await repo.remove("org-a", cluster.id, 1);
    expect(await repo.list("org-a")).toHaveLength(0);
    expect(await repo.membership("s1")).toBeNull();
    expect(await db.select().from(schema.servers)).toHaveLength(5);
  });
  it("removes network attachments on membership changes and cluster removal", async () => {
    const cluster = await repo.create("org-a", config(), "request-a", "hash-a");
    const next = config();
    next.members[1]!.serverId = "s3";
    const updated = await repo.update("org-a", cluster.id, 1, next);
    expect(
      (await db.select().from(schema.serverNetworkAttachment)).map((row) => row.serverId).sort(),
    ).toEqual(["s1", "s3"]);
    expect(updated.members.map((member) => member.serverId).sort()).toEqual(["s1", "s3"]);
    await repo.remove("org-a", cluster.id, updated.revision);
    expect(await db.select().from(schema.serverNetworkAttachment)).toHaveLength(0);
  });
  it("allows organization deletion to cascade through its infrastructure", async () => {
    await repo.create("org-a", config(), "request-a", "hash-a");
    await db.delete(schema.organization).where(eq(schema.organization.id, "org-a"));
    expect(await db.select().from(schema.serverCluster)).toHaveLength(0);
    expect(await db.select().from(schema.serverNetworkAttachment)).toHaveLength(0);
    expect((await db.select().from(schema.servers)).map((row) => row.id)).toEqual(["foreign"]);
  });
});
