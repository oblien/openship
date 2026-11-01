import { beforeEach, expect, it, vi } from "vitest";
import { getAppTemplate } from "@repo/core";
import type { RequestContext } from "../../../src/lib/request-context";

const h = vi.hoisted(() => ({
  template: vi.fn(),
  placement: vi.fn(),
  create: vi.fn(),
  service: vi.fn(),
  update: vi.fn(),
  draft: vi.fn(),
  list: vi.fn(),
  setEnv: vi.fn(),
  cloud: false,
  customer: false,
}));
vi.mock("@repo/platform/engine/modules/billing/management.service", () => ({ isCustomerServer: async () => h.customer }));
vi.mock("@repo/platform/engine/modules/apps/catalog-source", () => ({
  getTemplateForOrg: h.template,
}));
vi.mock("@repo/platform/engine/modules/projects/project-crud.service", () => ({
  createProject: h.create,
}));
vi.mock("@repo/platform/engine/modules/services/service.service", () => ({
  createService: h.service,
  updateService: h.update,
  setServiceEnvVars: h.setEnv,
}));
vi.mock("@repo/platform/engine/lib/cloud-workspace-scope", () => ({
  workspaceForServer: h.placement,
  resolveCloudProjectServer: h.placement,
}));
vi.mock("@repo/platform/engine/config/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/platform/engine/config/env")>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get CLOUD_MODE() {
        return h.cloud;
      },
    },
  };
});
vi.mock("@repo/db", () => ({
  repos: {
    project: {
      findDraftByAppTemplate: h.draft,
      getEnvMap: async () => ({}),
      mergeEnvVars: async () => {},
    },
    service: { listByProject: h.list },
    customAppTemplate: { findByAppId: async () => undefined, listByOrg: async () => [] },
  },
}));
import { installApp } from "@repo/platform/engine/modules/apps/app-install.service";

const ctx = { organizationId: "org-ai", userId: "user-ai" } as RequestContext;
beforeEach(() => {
  vi.clearAllMocks();
  h.cloud = false; h.customer = false;
  h.template.mockImplementation(async (_org, id) => ({ ...getAppTemplate(id)!, available: true }));
  h.placement.mockResolvedValue(null);
  h.draft.mockResolvedValue(null);
  h.list.mockResolvedValue([]);
  h.create.mockResolvedValue({ id: "project-ai", slug: "ai", name: "AI" });
});

it.each(
  ["ollama", "vllm", "open-webui"].flatMap((templateId) =>
    ["saas", "linked"].map((mode) => ({ templateId, mode })),
  ),
)(
  "rejects $templateId on $mode Cloud before any project/service write",
  async ({ templateId, mode }) => {
    h.cloud = mode === "saas";
    h.placement.mockResolvedValue({
      workspace: { id: "workspace-ai" },
      server: { id: "managed-ai" },
    });
    await expect(installApp(ctx, { templateId, serverId: "managed-ai" })).rejects.toMatchObject({
      code: "APP_CLOUD_UNSUPPORTED",
    });
    expect(h.create).not.toHaveBeenCalled();
    expect(h.service).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();

  },
);
it("creates CPU Ollama without GPU requests and uses the selected GPU mode on a self-hosted server", async () => {
  await installApp(ctx, { templateId: "ollama", serverId: "self-ai", useGpu: false });
  const cpu = h.service.mock.calls[0]![2];
  expect(cpu.advanced).not.toHaveProperty("gpus");
  expect(cpu.environment).toMatchObject({
    NVIDIA_VISIBLE_DEVICES: "void",
    CUDA_VISIBLE_DEVICES: "-1",
  });
  h.service.mockClear();
  await installApp(ctx, { templateId: "ollama", serverId: "self-ai", useGpu: true });
  expect(h.service.mock.calls[0]![2].advanced.gpus).toEqual([
    { driver: "nvidia", count: 1, capabilities: ["gpu"] },
  ]);
});
it("seeds vLLM shared memory and refuses a CPU downgrade before creating a draft", async () => {
  await installApp(ctx, { templateId: "vllm", serverId: "self-ai" });
  expect(h.service.mock.calls[0]![2].advanced).toMatchObject({
    shmSize: 2147483648,
    gpus: [{ count: 1 }],
  });
  h.create.mockClear();
  await expect(
    installApp(ctx, { templateId: "vllm", serverId: "self-ai", useGpu: false }),
  ).rejects.toThrow(/requires an NVIDIA/);
  expect(h.create).not.toHaveBeenCalled();
});
it("reopening a CPU draft applies the GPU choice without creating another project or losing custom environment", async () => {
  h.draft.mockResolvedValue({
    id: "project-ai",
    slug: "ollama",
    name: "Ollama",
    serverId: "self-ai",
  });
  h.list.mockResolvedValue([
    {
      id: "service-ai",
      name: "ollama",
      ports: [],
      environment: { CUSTOM: "kept", NVIDIA_VISIBLE_DEVICES: "void", CUDA_VISIBLE_DEVICES: "-1" },
    },
  ]);
  await installApp(ctx, { templateId: "ollama", serverId: "self-ai", useGpu: true });
  expect(h.create).not.toHaveBeenCalled();
  expect(h.service).not.toHaveBeenCalled();
  const patch = h.update.mock.calls[0]![3];
  expect(patch.advanced.gpus).toEqual([{ driver: "nvidia", count: 1, capabilities: ["gpu"] }]);
  expect(patch.environment.CUSTOM).toBe("kept");
  expect(patch.environment).not.toHaveProperty("NVIDIA_VISIBLE_DEVICES");
  expect(patch).not.toHaveProperty("publicEndpoints");
});

it("allows a self-hosted AI template on a paid customer-owned server from SaaS", async () => {
  h.cloud = true; h.customer = true;
  await installApp(ctx, { templateId: "ollama", serverId: "self-ai", useGpu: false });
  expect(h.create).toHaveBeenCalled();
  expect(h.placement).toHaveBeenCalledWith("org-ai", "self-ai");
});
