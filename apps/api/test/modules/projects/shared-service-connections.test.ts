import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  projects: new Map<string, Record<string, unknown>>(),
  services: new Map<string, Record<string, unknown>>(),
  links: [] as Array<Record<string, unknown>>,
  envRows: [] as Array<Record<string, unknown>>,
  outputs: [] as Array<Record<string, unknown>>,
  candidates: [] as Array<Record<string, unknown>>,
  save: vi.fn(), merge: vi.fn(), join: vi.fn(), leave: vi.fn(), dispose: vi.fn(), authorize: vi.fn(),
}));
vi.mock("@repo/platform/engine/lib/project-runtime-lock", () => ({
  withProjectRuntimeLock: async (_id: string, run: () => Promise<unknown>) => run(),
}));

vi.mock("@repo/db", () => ({ repos: {
  project: { findById: async (id: string) => h.projects.get(id), listEnvVars: async () => h.envRows },
  service: { findById: async (id: string) => h.services.get(id), listByDeployment: async () => [{ containerId: "adopted-web" }] },
  deployment: { findById: async (id: string) => ({ id, projectId: id === "dep-source" || id === "dep-new" ? "source" : "target", organizationId: "org", meta: {} }) },
  projectConnection: {
    listByTarget: async (id: string) => h.links.filter(link => link.targetProjectId === id),
    listBySource: async (id: string) => h.links.filter(link => link.sourceProjectId === id),
    listBySourceService: async (id: string) => h.links.filter(link => link.sourceServiceId === id),
    saveBindings: h.save,
  },
} }));
vi.mock("@repo/platform/engine/lib/authorization", () => ({ authorization: {
  authorize: h.authorize,
  checkPermissionOnResource: async (_ctx: unknown, resource: { resourceId: string }) => resource.resourceId !== "read-only",
} }));
vi.mock("@repo/platform/engine/lib/authorized-projects", () => ({ listAuthorizedProjects: async () => h.candidates }));
vi.mock("@repo/platform/engine/lib/deployment-runtime", () => ({ disposePlatform: h.dispose }));
vi.mock("@repo/platform/engine/lib/encryption", () => ({ encrypt: (value: string) => `enc:${value}`, decrypt: (value: string) => value.replace(/^enc:/, "") }));
vi.mock("@repo/platform/engine/modules/apps/catalog-source", () => ({ getTemplateForOrg: async () => undefined }));
vi.mock("@repo/platform/engine/modules/apps/app-settings.service", () => ({ getAppConnectionView: async () => ({ outputs: h.outputs }) }));
vi.mock("@repo/platform/engine/modules/projects/project-env.service", () => ({ mergeEnvVars: h.merge }));
vi.mock("@repo/platform/engine/modules/services/service-container", () => ({
  containerIdForService: async (dep: { id: string }, service: { id: string }) => `${dep.id}:${service.id}`,
  liveContainerIdWithRuntime: async (_runtime: unknown, input: { tracked: string }) => input.tracked,
  resolveServicePlatform: async () => ({ platform: {
    runtime: { joinServiceGroupContainers: h.join, leaveServiceGroupContainers: h.leave, listProjectContainerIds: async () => ["web-container"] },
    dispose: h.dispose,
  } }),
}));

import { createConnection, connectBundle, refreshConnectionEnv, listConnectionCandidates } from "@repo/platform/engine/modules/projects/project-connection.service";
import { disconnectSharedServiceNetwork } from "@repo/platform/engine/modules/projects/shared-service-network";
import { attachLinkedNetworks } from "@repo/platform/engine/modules/deployments/attach-linked-networks";
import { assertServiceNotShared } from "@repo/platform/engine/modules/services/shared-service-guard";

const ctx = { organizationId: "org", userId: "user" } as never;
const input = { sourceProjectId: "source", outputId: "svc_db:url", envKey: "DATABASE_URL", mode: "internal" as const };
beforeEach(() => {
  vi.clearAllMocks();
  h.authorize.mockImplementation(async context => context);
  h.candidates = [];
  h.projects = new Map(["source", "target"].map(id => [id, { id, slug: id, name: id, organizationId: "org", activeDeploymentId: id === "source" ? "dep-source" : "dep-target" }]));
  h.services = new Map([["svc_db", { id: "svc_db", projectId: "source", name: "db", enabled: true }]]);
  h.links = [];
  h.envRows = [];
  h.outputs = [{ id: "svc_db:url", sourceServiceId: "svc_db", service: "db", value: "postgresql://user:secret@db:5432/app", internal: true, secret: true }];
  h.save.mockImplementation(async (_target: string, _env: string, bindings: Array<{ connection: object }>) => bindings.map(binding => ({ id: "link", ...binding.connection })));
  h.authorize.mockImplementation(async ctx => ctx);
});

describe("connections to a service inside a project", () => {
  it("offers all eligible projects while excluding the current project and read-only access", async () => {
    h.candidates = ["source", "read-only", ...Array.from({ length: 120 }, (_, i) => `consumer-${i}`)].map(id => ({ id, name: id, environmentName: "production", appTemplateId: null }));
    const choices = await listConnectionCandidates(ctx, "source");
    expect(choices).toHaveLength(120);
    expect(choices.some(choice => ["source", "read-only"].includes(choice.id))).toBe(false);
    expect(h.authorize).toHaveBeenCalledWith(ctx, { resourceType: "project", resourceId: "source", action: "write" });
  });

  it("saves a reference and gives only the selected source container a stable shared address", async () => {
    const result = await createConnection(ctx, "target", input, { defer: true });
    expect(result.connection.sourceServiceId).toBe("svc_db");
    expect(h.save).toHaveBeenCalledWith("target", "production", [{
      connection: expect.objectContaining({ sourceProjectId: "source", sourceServiceId: "svc_db" }),
      encryptedValue: "enc:postgresql://user:secret@shared-svc-db:5432/app",
    }]);
    expect(h.join).toHaveBeenCalledExactlyOnceWith("shared-svc-db", [{ containerId: "dep-source:svc_db", aliases: ["shared-svc-db"] }], { strict: true });
    expect(h.dispose).toHaveBeenCalledOnce();
    expect(h.authorize).toHaveBeenCalledWith(ctx, { resourceType: "project", resourceId: "source", action: "write" });
  });

  it("does not publish a private service or write an invalid binding", async () => {
    await expect(createConnection(ctx, "target", { ...input, mode: "public" }, { defer: true })).rejects.toThrow(/private address/);
    expect(h.save).not.toHaveBeenCalled();
    expect(h.join).not.toHaveBeenCalled();
  });

  it("shares a service's token without requiring a deployment or granting network access", async () => {
    h.projects.get("source")!.activeDeploymentId = null;
    h.projects.get("source")!.serverId = "another-server";
    h.outputs = [{ id: "token", sourceServiceId: "svc_db", service: "db", value: "a-secret-token", secret: true }];
    await createConnection(ctx, "target", { ...input, outputId: "token", envKey: "SERVICE_TOKEN" }, { defer: true });
    expect(h.save).toHaveBeenCalledWith("target", "production", [expect.objectContaining({
      connection: expect.objectContaining({ sourceServiceId: "svc_db", usesPrivateNetwork: false }),
      encryptedValue: "enc:a-secret-token",
    })]);
    expect(h.join).not.toHaveBeenCalled();
    h.links = [{ id: "token-link", ...input, sourceServiceId: "svc_db", targetProjectId: "target", usesPrivateNetwork: false }];
    await attachLinkedNetworks("target", { joinServiceGroupContainers: h.join, attachToExternalNetworks: vi.fn() });
    expect(h.join).not.toHaveBeenCalled();
  });

  it("refuses connections while a source project is being deleted", async () => {
    h.projects.get("source")!.deletionInProgress = true;
    await expect(createConnection(ctx, "target", input, { defer: true })).rejects.toThrow(/being deleted/);
    expect(h.save).not.toHaveBeenCalled();
  });

  it("rejects cross-organization sources before resolving credentials", async () => {
    h.projects.get("source")!.organizationId = "other-org";
    await expect(createConnection(ctx, "target", input, { defer: true })).rejects.toThrow();
    expect(h.save).not.toHaveBeenCalled();
  });

  it("does not accept an output pointing to a service outside the source project", async () => {
    h.services.get("svc_db")!.projectId = "another-project";
    await expect(createConnection(ctx, "target", input, { defer: true })).rejects.toThrow(/no longer available/);
    expect(h.save).not.toHaveBeenCalled();
  });

  it("rejects conflicting env names before preparing a bundle", async () => {
    await expect(connectBundle(ctx, "target", { sourceProjectId: "source", items: [input, input] })).rejects.toThrow(/different environment variable/);
    expect(h.save).not.toHaveBeenCalled();
    expect(h.join).not.toHaveBeenCalled();
  });

  it("refreshes credentials on deploy while retaining the address across a service rename", async () => {
    h.links = [{ id: "link", ...input, targetProjectId: "target", sourceServiceId: "svc_db" }];
    h.services.get("svc_db")!.name = "primary-db";
    h.outputs[0]!.service = "primary-db";
    h.outputs[0]!.value = "postgresql://user:new-secret@primary-db:5432/app";
    expect(await refreshConnectionEnv(ctx, "target", "production")).toEqual({ DATABASE_URL: "postgresql://user:new-secret@shared-svc-db:5432/app" });
    expect(h.merge).toHaveBeenCalledWith("target", "org", { environment: "production", deletes: [], upserts: [{ key: "DATABASE_URL", value: "postgresql://user:new-secret@shared-svc-db:5432/app", isSecret: true }] });
    h.envRows = [{ key: "DATABASE_URL", value: "enc:postgresql://user:new-secret@shared-svc-db:5432/app" }];
    h.merge.mockClear();
    await refreshConnectionEnv(ctx, "target", "production");
    expect(h.merge).not.toHaveBeenCalled();
  });

  it("reconnects the replacement source container when its owning project redeploys", async () => {
    h.links = [{ id: "link", ...input, targetProjectId: "target", sourceServiceId: "svc_db" }];
    const attach = vi.fn();
    await attachLinkedNetworks("source", { joinServiceGroupContainers: h.join, attachToExternalNetworks: attach }, undefined, "dep-new");
    expect(h.join).toHaveBeenCalledWith("shared-svc-db", [{ containerId: "dep-new:svc_db", aliases: ["shared-svc-db"] }], { strict: true });
    expect(attach).toHaveBeenCalledWith("source", [], ["adopted-web"], { prunePrefix: "openship-shared-", retain: ["openship-shared-svc-db", "openship-source"], strict: true });
  });

  it("fails a source deployment if its replacement container cannot be shared", async () => {
    h.links = [{ id: "link", ...input, targetProjectId: "target", sourceServiceId: "svc_db" }];
    h.join.mockRejectedValueOnce(new Error("Docker network unavailable"));
    await expect(attachLinkedNetworks("source", { joinServiceGroupContainers: h.join, attachToExternalNetworks: vi.fn() }, undefined, "dep-new")).rejects.toThrow("Docker network unavailable");
  });

  it("preserves a project's own network when its slug starts with shared-", async () => {
    h.projects.get("target")!.slug = "shared-tools";
    const attach = vi.fn();
    await attachLinkedNetworks("target", { joinServiceGroupContainers: h.join, attachToExternalNetworks: attach });
    expect(attach).toHaveBeenCalledWith("target", [], ["adopted-web"], { prunePrefix: "openship-shared-", retain: ["openship-shared-tools"], strict: false });
  });

  it("preserves another consumer's network when disconnecting one project", async () => {
    h.links = [
      { id: "one", ...input, targetProjectId: "target", sourceServiceId: "svc_db" },
      { id: "two", ...input, targetProjectId: "other-target", sourceServiceId: "svc_db" },
    ];
    await disconnectSharedServiceNetwork(h.projects.get("source") as never, h.projects.get("target") as never, "svc_db", "one");
    expect(h.leave).toHaveBeenCalledWith("shared-svc-db", ["web-container", "adopted-web"]);
    await expect(assertServiceNotShared("svc_db")).rejects.toThrow(/Disconnect/);
  });
});
