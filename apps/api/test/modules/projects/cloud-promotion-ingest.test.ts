import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import {
  db,
  repos,
  schema,
  eq,
  dumpSubgraph,
  deleteProjectSubgraph,
  type DatabaseDump,
} from "@repo/db";
import { seedOwner, installFakeRunner, type SeededOwner } from "../jobs/_harness";
import { cloudRuntimeTarget } from "@repo/platform/engine/config/env";
import {
  ingestSubgraph,
  type IngestSubgraphInput,
} from "../../../src/modules/cloud/cloud-ingest.service";
import {
  projectPromotionDigest,
  type ProjectPromotion,
} from "@repo/platform/engine/lib/cloud/project-promotion";
import { cloudSaasRoutes } from "../../../src/modules/cloud/cloud-saas.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import { clientIpMiddleware } from "../../../src/middleware/client-ip";
import { shutdownRateLimit } from "../../../src/lib/rate-limit";

vi.mock("@repo/platform/engine/config/env", async (original) => {
  const config = await original<typeof import("@repo/platform/engine/config/env")>();
  return { ...config, env: { ...config.env, CLOUD_MODE: true } };
});

installFakeRunner();
let input: IngestSubgraphInput;
let projectId: string;
let receipt: ProjectPromotion;
let source: DatabaseDump;
let cloudOwner: SeededOwner;
const app = new Hono()
  .onError(handleApiError)
  .use("*", clientIpMiddleware)
  .route("/api/cloud", cloudSaasRoutes);

beforeAll(() => {
  vi.stubEnv("OPENSHIP_RATE_LIMIT_STORE", "memory");
});
afterAll(async () => {
  await shutdownRateLimit();
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  const local = await seedOwner();
  const cloud = (cloudOwner = await seedOwner());
  const group = await repos.projectGroup.create({
    organizationId: local.orgId,
    name: "Transfer",
    slug: `transfer-${local.userId}`,
  });
  const project = await repos.project.create({
    organizationId: local.orgId,
    groupId: group.id,
    name: "Transfer",
    slug: group.slug,
    localPath: "/private/local-source",
    gitProvider: "local",
  });
  projectId = project.id;
  await db
    .insert(schema.service)
    .values({ id: `svc_${projectId}`, projectId, name: "web", image: "nginx:alpine" });
  await db.insert(schema.deployment).values({
    id: `dep_${projectId}`,
    projectId,
    organizationId: local.orgId,
    branch: "main",
    status: "ready",
    containerId: "local-container",
  });
  source = await dumpSubgraph(
    { kind: "project", projectId },
    { stripEncrypted: true, stripInstanceRefs: true },
  );
  receipt = {
    id: randomUUID(),
    target: { apiUrl: cloudRuntimeTarget.api, userId: cloud.userId, organizationId: cloud.orgId },
    sourceDigest: projectPromotionDigest(source),
    imported: null,
  };
  source.tables.project[0].cloudPromotion = receipt;
  input = {
    organizationId: cloud.orgId,
    dump: source,
    promotion: { id: receipt.id, userId: cloud.userId },
  };
  // Simulate the separate source and destination databases: the destination
  // starts with its tenant identities and none of the transferred rows.
  await deleteProjectSubgraph(projectId);
  await db.delete(schema.projectGroup).where(eq(schema.projectGroup.id, group.id));
});

describe("Cloud promotion receipts and atomic ingest", () => {
  it("keeps the local cleanup fence off the imported Cloud project", async () => {
    receipt.cleanupInProgress = true;
    source.tables.project[0].deletionInProgress = true;
    await ingestSubgraph(input);
    const imported = await repos.project.findById(projectId);
    expect(imported?.deletionInProgress).toBe(false);
    expect(imported?.cloudPromotion?.cleanupInProgress).toBeUndefined();
    await repos.project.update(projectId, { buildCommand: "cloud edit" });
    expect((await repos.project.findById(projectId))?.buildCommand).toBe("cloud edit");
  });

  it("authenticates the HTTP promotion and derives its tenant and user from the session", async () => {
    const endpoint = "/api/cloud/promote-project";
    const body = { dump: input.dump, promotionId: receipt.id };
    const post = (payload: unknown, headers: Record<string, string> = {}) =>
      app.request(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(payload),
      });
    expect((await post(body)).status).toBe(401);
    expect(await repos.project.findById(projectId)).toBeUndefined();
    const token = `cloud-session-${randomUUID()}`;
    await db.insert(schema.session).values({
      id: randomUUID(),
      token,
      userId: cloudOwner.userId,
      activeOrganizationId: cloudOwner.orgId,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const headers = {
      Authorization: `Bearer ${token}`,
      "X-Organization-Id": cloudOwner.orgId,
      "X-Openship-Scope": "fixed",
    };
    const forged = structuredClone(body);
    (forged.dump.tables.project[0].cloudPromotion as ProjectPromotion).target.userId =
      "another-user";
    const denied = await post({ ...forged, userId: "another-user" }, headers);
    expect(denied.status, await denied.clone().text()).toBe(400);
    expect(await denied.json()).toMatchObject({ code: "INGEST_VALIDATION_FAILED" });
    expect(await repos.project.findById(projectId)).toBeUndefined();
    const accepted = await post(body, headers);
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    expect(await accepted.json()).toMatchObject({
      ok: true,
      organizationId: cloudOwner.orgId,
      promotionId: receipt.id,
    });
    const retry = await post(body, headers);
    expect(retry.status).toBe(200);
    const conflictBody = structuredClone(body);
    (conflictBody.dump.tables.project[0].cloudPromotion as ProjectPromotion).id =
      conflictBody.promotionId = randomUUID();
    const conflict = await post(conflictBody, headers);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "TRANSFER_CONFLICT" });
    expect(await repos.service.listByProject(projectId)).toHaveLength(1);
  });

  it("bounds promotion uploads before authenticating them", async () => {
    const result = await app.request("/api/cloud/promote-project", {
      method: "POST",
      headers: { "content-length": "50000001", "content-type": "application/json" },
      body: "{}",
    });
    expect(result.status).toBe(413);
    expect(await result.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    expect(await repos.project.findById(projectId)).toBeUndefined();
  });

  it("commits once under concurrent retries and returns the original receipt", async () => {
    const [first, retry] = await Promise.all([ingestSubgraph(input), ingestSubgraph(input)]);
    expect(retry).toEqual(first);
    expect(first).toMatchObject({
      promotionId: receipt.id,
      organizationId: input.organizationId,
      imported: { project: 1, service: 1, deployment: 1 },
    });
    expect(await repos.project.findById(projectId)).toMatchObject({
      organizationId: input.organizationId,
      localPath: null,
      cloudPromotion: { ...receipt, imported: first.imported },
    });
    expect(await repos.deployment.findById(`dep_${projectId}`)).toMatchObject({
      containerId: null,
    });
    expect(await repos.service.listByProject(projectId)).toHaveLength(1);
  });

  it("does not overwrite Cloud edits when retrying cleanup", async () => {
    const first = await ingestSubgraph(input);
    await repos.project.update(projectId, { buildCommand: "cloud-side-change" });
    expect(await ingestSubgraph(input)).toEqual(first);
    expect((await repos.project.findById(projectId))?.buildCommand).toBe("cloud-side-change");
  });

  it.each(["id", "digest", "tenant", "user"])(
    "refuses a conflicting %s without changing the existing project",
    async (field) => {
      await ingestSubgraph(input);
      const changed = structuredClone(input);
      const state = changed.dump.tables.project[0].cloudPromotion as ProjectPromotion;
      if (field === "id") state.id = changed.promotion!.id = randomUUID();
      if (field === "digest") state.sourceDigest = "f".repeat(64);
      if (field === "tenant") {
        const stranger = await seedOwner();
        changed.organizationId = state.target.organizationId = stranger.orgId;
        changed.promotion!.userId = state.target.userId = stranger.userId;
      }
      if (field === "user") changed.promotion!.userId = state.target.userId = "another-user";
      await expect(ingestSubgraph(changed)).rejects.toMatchObject({ code: "TRANSFER_CONFLICT" });
      expect((await repos.project.findById(projectId))?.cloudPromotion?.id).toBe(receipt.id);
      expect((await repos.project.findById(projectId))?.organizationId).toBe(input.organizationId);
    },
  );

  it("rejects legacy copies without a trusted promotion receipt", async () => {
    await ingestSubgraph({ organizationId: input.organizationId, dump: input.dump });
    expect((await repos.project.findById(projectId))?.cloudPromotion).toBeNull();
    await expect(ingestSubgraph(input)).rejects.toMatchObject({ code: "TRANSFER_CONFLICT" });
  });

  it.each([true, false])(
    "never reuses a shared parent owned by another tenant (promotion: %s)",
    async (promotion) => {
      const stranger = await seedOwner();
      const groupId = String(input.dump.tables.project_app[0].id);
      await db.insert(schema.projectGroup).values({
        id: groupId,
        organizationId: stranger.orgId,
        name: "Other tenant's app",
        slug: `foreign-${projectId}`,
      });
      await expect(
        ingestSubgraph({ ...input, promotion: promotion ? input.promotion : undefined }),
      ).rejects.toMatchObject({ code: "PK_COLLISION" });
      expect(await repos.project.findById(projectId)).toBeUndefined();
      expect(await repos.service.listByProject(projectId)).toHaveLength(0);
      expect(await repos.projectGroup.findById(groupId)).toMatchObject({
        organizationId: stranger.orgId,
      });
    },
  );

  it("reuses the destination tenant's shared parent without overwriting it", async () => {
    const groupId = String(input.dump.tables.project_app[0].id);
    await db.insert(schema.projectGroup).values({
      id: groupId,
      organizationId: input.organizationId,
      name: "Existing group",
      slug: `existing-${projectId}`,
    });
    const result = await ingestSubgraph(input);
    expect(result.promotionId).toBe(receipt.id);
    expect(await repos.project.findById(projectId)).toMatchObject({
      groupId,
      organizationId: input.organizationId,
    });
    expect(await repos.projectGroup.findById(groupId)).toMatchObject({ name: "Existing group" });
  });

  it("does not recreate a deleted target after a confirmed import", async () => {
    const result = await ingestSubgraph(input);
    (input.dump.tables.project[0].cloudPromotion as ProjectPromotion).imported = result.imported;
    await deleteProjectSubgraph(projectId);
    await expect(ingestSubgraph(input)).rejects.toMatchObject({ code: "TRANSFER_TARGET_MISSING" });
    expect(await repos.project.findById(projectId)).toBeUndefined();
  });

  it("rolls back the project and receipt together when a later table fails", async () => {
    const group = await repos.projectGroup.create({
      organizationId: input.organizationId,
      name: "Unrelated",
      slug: `unrelated-${projectId}`,
    });
    const other = await repos.project.create({
      organizationId: input.organizationId,
      groupId: group.id,
      name: "Unrelated",
      slug: group.slug,
    });
    const hostname = `${projectId.toLowerCase().replaceAll("_", "-")}.example.test`;
    await db
      .insert(schema.domain)
      .values({ id: `dom_existing_${projectId}`, projectId: other.id, hostname });
    input.dump.tables.domain.push({ id: `dom_new_${projectId}`, projectId, hostname });
    await expect(ingestSubgraph(input)).rejects.toMatchObject({ code: "PK_COLLISION" });
    expect(await repos.project.findById(projectId)).toBeUndefined();
    expect(await repos.service.listByProject(projectId)).toHaveLength(0);
    expect(await repos.domain.findByHostname(hostname)).toMatchObject({ projectId: other.id });
  });

  it("rejects malformed scopes and receipt targets before importing", async () => {
    for (const change of [
      (value: IngestSubgraphInput) => {
        value.dump.scope = { kind: "organization", organizationId: input.organizationId };
      },
      (value: IngestSubgraphInput) => {
        (value.dump.tables.project[0].cloudPromotion as ProjectPromotion).target.organizationId =
          "foreign";
      },
      (value: IngestSubgraphInput) => {
        value.dump.tables.project.push({ id: "another-project" });
      },
    ]) {
      const invalid = structuredClone(input);
      change(invalid);
      await expect(ingestSubgraph(invalid)).rejects.toMatchObject({
        code: "INGEST_VALIDATION_FAILED",
      });
      expect(await repos.project.findById(projectId)).toBeUndefined();
    }
  });
});
