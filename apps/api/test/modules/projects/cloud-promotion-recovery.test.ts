import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, repos, schema, eq, type DatabaseDump } from "@repo/db";
import type { ExecutionContext } from "@repo/platform";
import { seedOwner, installFakeRunner } from "../jobs/_harness";

const remote = vi.hoisted(() => ({
  identity: {
    apiUrl: "https://api.openship.io",
    userId: "cloud-user",
    organizationId: "cloud-org",
  },
  ingest: vi.fn(),
  cleanup: vi.fn(),
  calls: [] as {
    path: string;
    body: { dump: DatabaseDump; promotionId?: string };
    identity: unknown;
  }[],
}));
vi.mock("@repo/platform/engine/lib/cloud/server-link", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/lib/cloud/server-link")>()),
  linkedCloudIdentity: async () => ({ ...remote.identity }),
}));
vi.mock("@repo/platform/engine/lib/cloud/transport", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/lib/cloud/transport")>()),
  cloudFetchAsOrgOwner: async (
    _org: string,
    path: string,
    init: RequestInit,
    identity: unknown,
  ) => {
    const body = JSON.parse(String(init.body));
    remote.calls.push({ path, body, identity });
    return remote.ingest(body);
  },
}));
vi.mock("@repo/platform/engine/modules/projects/project-cleanup.service", async (original) => ({
  ...(await original<
    typeof import("@repo/platform/engine/modules/projects/project-cleanup.service")
  >()),
  collectProjectManifest: async () => ({
    resources: [{ type: "container", ref: "owned-local-container", label: "local API" }],
  }),
  executeCleanup: remote.cleanup,
}));

import {
  promoteProjectToCloud,
  TransferConflictError,
} from "@repo/platform/engine/modules/projects/transfer.service";
import { projectPromotionDigest } from "@repo/platform/engine/lib/cloud/project-promotion";
import { dumpSubgraph } from "@repo/db";

installFakeRunner();
let context: ExecutionContext;
let projectId: string;
let imported: DatabaseDump | undefined;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  remote.ingest.mockReset();
  remote.cleanup.mockReset();
  remote.calls.length = 0;
  remote.identity.userId = "cloud-user";
  remote.identity.organizationId = "cloud-org";
  imported = undefined;
  const owner = await seedOwner();
  context = { userId: owner.userId, organizationId: owner.orgId } as ExecutionContext;
  const group = await repos.projectGroup.create({
    organizationId: owner.orgId,
    name: "Local app",
    slug: "local-app",
  });
  const project = await repos.project.create({
    organizationId: owner.orgId,
    groupId: group.id,
    name: "Local app",
    slug: "local-app",
    gitProvider: "local",
    localPath: "/local-source",
  });
  projectId = project.id;
  await db.insert(schema.deployment).values({
    id: `dep_${projectId}`,
    projectId,
    organizationId: owner.orgId,
    branch: "main",
    status: "ready",
  });
  await repos.project.mergeEnvVars(
    projectId,
    "production",
    [{ key: "API_SECRET", value: "encrypted-source-only", isSecret: true }],
    [],
  );
  remote.ingest.mockImplementation(async ({ dump, promotionId }) => {
    // The old endpoint imports once, then returns a primary-key collision.
    // Only the receipt-aware endpoint can acknowledge the original import.
    if (!promotionId && imported)
      return Response.json(
        { error: "Project ID already exists", code: "PK_COLLISION" },
        { status: 409 },
      );
    imported ??= structuredClone(dump);
    if (promotionId)
      expect((imported!.tables.project[0].cloudPromotion as { id: string }).id).toBe(promotionId);
    return Response.json({
      ok: true,
      organizationId: "cloud-org",
      publicUrl: "https://app.openship.io",
      imported: { project: 1, deployment: 1 },
      promotionId,
    });
  });
  remote.cleanup.mockResolvedValue({ total: 1, succeeded: 1, failed: [] });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("project promotion recovery", () => {
  it("retries real local teardown after a failed cleanup, preserving the original import receipt", async () => {
    remote.cleanup.mockResolvedValueOnce({
      total: 1,
      succeeded: 0,
      failed: [{ label: "local API", error: "Docker unavailable" }],
    });
    const first = await promoteProjectToCloud(context, projectId);
    expect(first).toMatchObject({ localRemoved: false, imported: { project: 1, deployment: 1 } });
    const retained = await repos.project.findById(projectId);
    expect(retained?.deletionInProgress).toBe(false);
    expect(await repos.deployment.findById(`dep_${projectId}`)).toBeDefined();
    const retry = await promoteProjectToCloud(context, projectId);
    expect(retry.localRemoved).toBe(true);
    expect(retained?.cloudPromotion?.imported).toEqual(first.imported);
    expect(await repos.project.findById(projectId)).toBeUndefined();
    expect(await repos.deployment.findById(`dep_${projectId}`)).toBeUndefined();
    expect(remote.calls.map((call) => call.path)).toEqual([
      "/api/cloud/promote-project",
      "/api/cloud/promote-project",
    ]);
    expect(remote.calls[1].body.promotionId).toBe(remote.calls[0].body.promotionId);
    expect(remote.calls[1].identity).toEqual(remote.calls[0].identity);
    expect(JSON.stringify(imported)).not.toContain("encrypted-source-only");
  });

  it("recovers a lost Cloud response using the receipt saved before the request", async () => {
    const receive = remote.ingest.getMockImplementation()!;
    remote.ingest.mockImplementationOnce(async (body) => {
      await receive(body);
      return null;
    });
    await expect(promoteProjectToCloud(context, projectId)).rejects.toThrow("not connected");
    expect(imported?.tables.project[0].id).toBe(projectId);
    const receipt = (await repos.project.findById(projectId))!.cloudPromotion;
    expect(receipt?.imported).toBeNull();
    expect(remote.cleanup).not.toHaveBeenCalled();
    expect((await promoteProjectToCloud(context, projectId)).localRemoved).toBe(true);
    expect(remote.calls.map((call) => call.body.promotionId)).toEqual([receipt!.id, receipt!.id]);
  });

  it("retries a failed database deletion after runtime cleanup has completed", async () => {
    vi.spyOn(repos.project, "deleteHard").mockRejectedValueOnce(new Error("Database unavailable"));
    const first = await promoteProjectToCloud(context, projectId);
    expect(first.localRemoved).toBe(false);
    expect((await repos.project.findById(projectId))?.cloudPromotion?.imported).toEqual(
      first.imported,
    );
    expect((await promoteProjectToCloud(context, projectId)).localRemoved).toBe(true);
    expect(remote.calls[1].body.promotionId).toBe(remote.calls[0].body.promotionId);
    expect(await repos.project.findById(projectId)).toBeUndefined();
  });

  it("keeps the local secret until the webhook forwarding binding is durably saved", async () => {
    await repos.project.update(projectId, {
      gitOwner: "owner",
      gitRepo: "app",
      webhookId: 42,
      webhookSecret: "encrypted-webhook-secret",
    });
    vi.spyOn(repos.cloudWebhookBinding, "upsert").mockRejectedValueOnce(
      new Error("Binding write unavailable"),
    );
    await expect(promoteProjectToCloud(context, projectId)).rejects.toThrow(
      "Binding write unavailable",
    );
    expect(remote.cleanup).not.toHaveBeenCalled();
    expect((await repos.project.findById(projectId))?.webhookSecret).toBe(
      "encrypted-webhook-secret",
    );
    expect((await promoteProjectToCloud(context, projectId)).localRemoved).toBe(true);
    expect(remote.calls[1].body.promotionId).toBe(remote.calls[0].body.promotionId);
  });

  it("keeps both copies when the local configuration changed after import", async () => {
    remote.cleanup.mockResolvedValueOnce({
      total: 1,
      succeeded: 0,
      failed: [{ label: "API", error: "busy" }],
    });
    await promoteProjectToCloud(context, projectId);
    await repos.project.mergeEnvVars(
      projectId,
      "production",
      [{ key: "API_SECRET", value: "new-private-value", isSecret: true }],
      [],
    );
    await expect(promoteProjectToCloud(context, projectId)).rejects.toMatchObject({
      code: "TRANSFER_SOURCE_CHANGED",
    });
    expect(remote.calls).toHaveLength(1);
    expect(remote.cleanup).toHaveBeenCalledTimes(1);
    expect(await repos.project.findById(projectId)).toBeDefined();
  });

  it("refuses cleanup when an edit occurs during the Cloud call", async () => {
    remote.ingest.mockImplementationOnce(async ({ promotionId }) => {
      await repos.project.update(projectId, { buildCommand: "new build" });
      return Response.json({
        ok: true,
        organizationId: "cloud-org",
        imported: { project: 1 },
        promotionId,
      });
    });
    await expect(promoteProjectToCloud(context, projectId)).rejects.toMatchObject({
      code: "TRANSFER_SOURCE_CHANGED",
    });
    expect(remote.cleanup).not.toHaveBeenCalled();
    expect((await repos.project.findById(projectId))?.buildCommand).toBe("new build");
  });

  it("preserves a settings edit accepted after import confirmation and before cleanup", async () => {
    await repos.project.update(projectId, {
      gitOwner: "owner",
      gitRepo: "app",
      webhookId: 42,
    });
    const { updateProject } =
      await import("@repo/platform/engine/modules/projects/project-crud.service");
    const reachedClaim = deferred();
    const resumeClaim = deferred();
    const claimDeletion = repos.project.claimDeletion.bind(repos.project);
    vi.spyOn(repos.project, "claimDeletion").mockImplementationOnce(async (...input) => {
      reachedClaim.resolve();
      await resumeClaim.promise;
      return claimDeletion(...input);
    });
    const promotion = promoteProjectToCloud(context, projectId).then(
      (result) => ({ result, error: undefined }),
      (error) => ({ result: undefined, error }),
    );
    await reachedClaim.promise;
    try {
      expect((await repos.project.findById(projectId))?.cloudPromotion?.imported).toBeTruthy();
      const updated = await updateProject(
        projectId,
        { buildCommand: "new build after import" },
        context.organizationId,
      );
      expect(updated.buildCommand).toBe("new build after import");
      expect(imported?.tables.project[0].buildCommand).not.toBe("new build after import");
    } finally {
      resumeClaim.resolve();
    }
    const outcome = await promotion;
    expect(outcome.error).toMatchObject({ code: "TRANSFER_SOURCE_CHANGED" });
    expect(remote.cleanup).not.toHaveBeenCalled();
    expect(await repos.project.findById(projectId)).toMatchObject({
      buildCommand: "new build after import",
      deletionInProgress: false,
    });
    expect(
      (await repos.project.findById(projectId))?.cloudPromotion?.cleanupInProgress,
    ).toBeUndefined();
  });

  it("rejects configuration edits during cleanup and admits them again after cleanup fails", async () => {
    const { updateProject } =
      await import("@repo/platform/engine/modules/projects/project-crud.service");
    const { updateService } =
      await import("@repo/platform/engine/modules/services/service.service");
    const { mergeEnvVars } =
      await import("@repo/platform/engine/modules/projects/project-env.service");
    const service = await repos.service.create({ projectId, name: "api", image: "node:22" });
    const reachedCleanup = deferred();
    const resumeCleanup = deferred();
    remote.cleanup.mockImplementationOnce(async () => {
      reachedCleanup.resolve();
      await resumeCleanup.promise;
      return { total: 1, succeeded: 0, failed: [{ label: "API", error: "busy" }] };
    });
    const promotion = promoteProjectToCloud(context, projectId);
    await reachedCleanup.promise;
    const edits = [
      () => updateProject(projectId, { buildCommand: "new build" }, context.organizationId),
      () => updateService(context, projectId, service.id, { image: "node:24" }),
      () =>
        mergeEnvVars(projectId, context.organizationId, {
          environment: "production",
          upserts: [{ key: "NEW_KEY", value: "new value", isSecret: true }],
          deletes: [],
        }),
    ];
    try {
      expect((await repos.project.findById(projectId))?.cloudPromotion?.cleanupInProgress).toBe(
        true,
      );
      for (const edit of edits)
        await expect(edit()).rejects.toMatchObject({ code: "PROJECT_TRANSFER_IN_PROGRESS" });
    } finally {
      resumeCleanup.resolve();
    }
    expect((await promotion).localRemoved).toBe(false);
    expect(
      (await repos.project.findById(projectId))?.cloudPromotion?.cleanupInProgress,
    ).toBeUndefined();
    for (const edit of edits) await edit();
    expect((await repos.project.findById(projectId))?.buildCommand).toBe("new build");
    expect((await repos.service.findById(service.id))?.image).toBe("node:24");
  });

  it("preserves work admitted after import instead of cancelling it for cleanup", async () => {
    await repos.project.update(projectId, { gitOwner: "owner", gitRepo: "app", webhookId: 42 });
    const claimDeletion = repos.project.claimDeletion.bind(repos.project);
    let admittedId: string | undefined;
    vi.spyOn(repos.project, "claimDeletion").mockImplementationOnce(async (...input) => {
      const admitted = await repos.deployment.create({
        projectId,
        organizationId: context.organizationId,
        branch: "main",
        status: "queued",
      });
      admittedId = admitted?.id;
      return claimDeletion(...input);
    });
    const result = await promoteProjectToCloud(context, projectId);
    expect(result.localRemoved).toBe(false);
    expect(admittedId).toBeTruthy();
    expect((await repos.deployment.findById(admittedId!))?.status).toBe("queued");
    expect(remote.cleanup).not.toHaveBeenCalled();
    expect((await repos.project.findById(projectId))?.deletionInProgress).toBe(false);
  });

  it("reclaims a configuration fence left by a crashed cleanup using the same receipt", async () => {
    remote.cleanup.mockResolvedValueOnce({
      total: 1,
      succeeded: 0,
      failed: [{ label: "API", error: "busy" }],
    });
    await promoteProjectToCloud(context, projectId);
    await repos.project.claimDeletion(projectId, { protectConfiguration: true });
    await expect(repos.project.update(projectId, { name: "late edit" })).rejects.toMatchObject({
      code: "PROJECT_TRANSFER_IN_PROGRESS",
    });
    expect((await promoteProjectToCloud(context, projectId)).localRemoved).toBe(true);
    expect(remote.calls[1].body.promotionId).toBe(remote.calls[0].body.promotionId);
    expect(await repos.project.findById(projectId)).toBeUndefined();
  });

  it("requires the original Cloud account on a later retry", async () => {
    remote.cleanup.mockResolvedValueOnce({
      total: 1,
      succeeded: 0,
      failed: [{ label: "API", error: "busy" }],
    });
    await promoteProjectToCloud(context, projectId);
    remote.identity.organizationId = "different-cloud-org";
    await expect(promoteProjectToCloud(context, projectId)).rejects.toMatchObject({
      code: "TRANSFER_CONNECTION_CHANGED",
    });
    expect(remote.calls).toHaveLength(1);
    expect(remote.cleanup).toHaveBeenCalledTimes(1);
  });

  it("preserves the source if the account is reconnected during the Cloud request", async () => {
    const receive = remote.ingest.getMockImplementation()!;
    remote.ingest.mockImplementationOnce(async (body) => {
      const response = await receive(body);
      remote.identity.userId = "different-cloud-user";
      return response;
    });
    await expect(promoteProjectToCloud(context, projectId)).rejects.toMatchObject({
      code: "TRANSFER_CONNECTION_CHANGED",
    });
    expect(remote.cleanup).not.toHaveBeenCalled();
    expect(await repos.project.findById(projectId)).toBeDefined();
  });

  it("never treats an old duplicate without a receipt as permission to delete locally", async () => {
    remote.ingest.mockResolvedValueOnce(
      Response.json(
        { error: "Existing project has no matching receipt", code: "TRANSFER_CONFLICT" },
        { status: 409 },
      ),
    );
    await expect(promoteProjectToCloud(context, projectId)).rejects.toBeInstanceOf(
      TransferConflictError,
    );
    expect(await repos.project.findById(projectId)).toBeDefined();
    expect(remote.cleanup).not.toHaveBeenCalled();
  });

  it("rejects an unconfirmed receipt before teardown", async () => {
    remote.ingest.mockResolvedValueOnce(
      Response.json({ ok: true, organizationId: "cloud-org", imported: { project: 1 } }),
    );
    await expect(promoteProjectToCloud(context, projectId)).rejects.toMatchObject({
      code: "TRANSFER_RECEIPT_INVALID",
    });
    expect(remote.cleanup).not.toHaveBeenCalled();
  });

  it("requires confirmation that exactly one project was imported", async () => {
    remote.ingest.mockImplementationOnce(async ({ promotionId }) =>
      Response.json({ ok: true, organizationId: "cloud-org", imported: {}, promotionId }),
    );
    await expect(promoteProjectToCloud(context, projectId)).rejects.toMatchObject({
      code: "TRANSFER_RECEIPT_INVALID",
    });
    expect(remote.cleanup).not.toHaveBeenCalled();
    expect(await repos.project.findById(projectId)).toBeDefined();
  });

  it("does not fall back to the legacy import endpoint when Cloud lacks receipt support", async () => {
    remote.ingest.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));
    await expect(promoteProjectToCloud(context, projectId)).rejects.toMatchObject({
      code: "TRANSFER_CLOUD_FAILED",
    });
    expect(remote.calls.map((call) => call.path)).toEqual(["/api/cloud/promote-project"]);
    expect(remote.cleanup).not.toHaveBeenCalled();
    expect(await repos.project.findById(projectId)).toBeDefined();
  });

  it("permits a corrected name after Cloud definitively rejected the import", async () => {
    remote.ingest.mockResolvedValueOnce(
      Response.json({ error: "Name taken", code: "SLUG_TAKEN" }, { status: 409 }),
    );
    await expect(promoteProjectToCloud(context, projectId)).rejects.toMatchObject({
      conflictKind: "slug",
    });
    expect((await repos.project.findById(projectId))?.cloudPromotion).toBeNull();
    await repos.project.update(projectId, { slug: "renamed-local" });
    expect((await promoteProjectToCloud(context, projectId)).localRemoved).toBe(true);
    expect(remote.calls[1].body.promotionId).not.toBe(remote.calls[0].body.promotionId);
  });

  it("does not snapshot an active build, and does not mistake metrics for source edits", async () => {
    await db
      .update(schema.deployment)
      .set({ status: "building" })
      .where(eq(schema.deployment.id, `dep_${projectId}`));
    await expect(promoteProjectToCloud(context, projectId)).rejects.toMatchObject({
      code: "TRANSFER_ACTIVE_WORK",
    });
    expect(remote.calls).toHaveLength(0);
    expect((await repos.project.findById(projectId))?.cloudPromotion).toBeNull();
    const dump = await dumpSubgraph({ kind: "project", projectId });
    const changed = structuredClone(dump);
    changed.tables.resource_usage.push({ id: "another-sample", projectId, cpu: 42 });
    changed.tables.project[0].favicon = "new favicon";
    expect(projectPromotionDigest(changed)).toBe(projectPromotionDigest(dump));
    changed.tables.project[0].localPath = "/another-source";
    expect(projectPromotionDigest(changed)).not.toBe(projectPromotionDigest(dump));
  });
});
