import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { ExecutionContext } from "@repo/platform";

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  service: vi.fn(),
  server: vi.fn(),
  identity: {
    apiUrl: "https://api.openship.test",
    userId: "cloud-user",
    organizationId: "cloud-org",
  },
}));
vi.mock("@repo/platform/engine/lib/cloud/transport", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/lib/cloud/transport")>()),
  resolveOrgCloudUserId: async () => "linked-owner",
  readCloudSession: async () => ({ ...h.identity, token: "upstream-session" }),
  cloudFetchAsOrgOwner: h.fetch,
}));
vi.mock("@repo/platform/engine/lib/platform", async (original) => {
  const actual = await original<typeof import("@repo/platform/engine/lib/platform")>();
  return {
    ...actual,
    getPlatformKernel() {
      const kernel = actual.getPlatformKernel();
      return {
        ...kernel,
        servers: { ...kernel.servers, get: h.server },
        // Stop before the provider-side install. Project creation, permission
        // checks and the durable provisioning journal remain real.
        services: { ...kernel.services, create: h.service },
      };
    },
  };
});

import { db, schema, repos, seedOwner } from "../jobs/_harness";
import { eq } from "@repo/db";
import {
  beginProvisioning,
  provisionInstance,
  provisioningRunning,
} from "../../../src/modules/system/instance/provision-instance";
import { journal } from "../../../src/modules/system/instance/handoff-peer";

afterEach(async () => {
  // Each case stopped before handoff; clear only this fixture's reservation.
  await db
    .update(schema.instanceController)
    .set({ handoffId: null })
    .where(eq(schema.instanceController.id, "local"));
  vi.restoreAllMocks();
});

describe("instance provisioning retains the source controller's authority", () => {
  it.each(["desktop", "browser"] as const)(
    "keeps %s setup local on a linked Cloud destination and reuses it on resume",
    async (access) => {
      h.fetch.mockReset();
      h.server.mockReset();
      h.service.mockReset();
      const owner = await seedOwner({ instanceAdmin: true, bound: false });
      h.identity.organizationId = `cloud-${owner.orgId}`;
      const workspace = await repos.cloudWorkspace.link({
        organizationId: owner.orgId,
        name: "Managed destination",
        remote: { ...h.identity, serverId: "cloud-server", workspaceId: "cloud-workspace" },
      });
      const server = (await repos.server.findByWorkspace(workspace.id, owner.orgId))!;
      h.server.mockResolvedValue({ data: { ...server, isLocal: false } });
      h.service.mockRejectedValue(new Error("Paused before provider installation"));
      h.fetch.mockResolvedValue(
        Response.json(
          {
            data: {
              id: `cloud-project-${randomUUID()}`,
              organizationId: h.identity.organizationId,
              groupId: "cloud-group",
              name: "Cloud setup",
              slug: "cloud-setup",
              serverId: "cloud-server",
              workspaceId: "cloud-workspace",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          },
          { status: 201 },
        ),
      );
      const ctx = {
        userId: owner.userId,
        organizationId: owner.orgId,
        role: "owner",
        scopeMode: "resource",
      } as ExecutionContext;
      const origin = "http://127.0.0.1:4000";
      const id = await beginProvisioning(
        ctx,
        {
          serverId: server.id,
          access,
          domain: { kind: "custom", hostname: "ops.example.test" },
          confirmed: true,
        },
        origin,
      );
      // Await the same in-flight recipe started by beginProvisioning.
      await provisionInstance(ctx, id, origin);
      expect(provisioningRunning(id)).toBe(false);
      const first = await journal(id);
      expect(first.error).toBe("Paused before provider installation");
      expect(first.provisioning?.projectId).toBeTruthy();
      const projectId = first.provisioning!.projectId!;
      expect(await repos.project.findById(projectId)).toMatchObject({
        organizationId: owner.orgId,
        serverId: server.id,
        workspaceId: workspace.id,
      });
      expect((await repos.project.listByOrganization(owner.orgId)).rows).toHaveLength(1);
      expect(h.fetch).not.toHaveBeenCalled();

      // The original browser context is still unrestricted on a later attempt.
      await provisionInstance(ctx, id, origin);
      expect((await journal(id)).provisioning?.projectId).toBe(projectId);
      expect((await repos.project.listByOrganization(owner.orgId)).rows).toHaveLength(1);
      expect(h.fetch).not.toHaveBeenCalled();
    },
  );
});
