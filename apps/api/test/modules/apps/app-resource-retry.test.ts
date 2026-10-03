import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Service } from "@repo/db";
import type { DeploymentConfigSnapshot } from "@repo/core";

const h = vi.hoisted(() => ({ rows: [] as Service[], seed: vi.fn() }));
vi.mock("@repo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/db")>()),
  repos: {
    service: { listByProject: async () => h.rows, seedDraftAppResourceDefaults: h.seed },
    serviceDeployment: { latestByProject: async () => new Map() },
    customAppTemplate: { findByAppId: async () => undefined },
  },
}));

import { getAppTemplate } from "@repo/core";
import { resolveServicePipelineMode } from "@repo/platform/engine/modules/deployments/build-pipeline";
import { cloudDockerResources } from "@repo/platform/engine/lib/cloud-docker-workspace";

const project = {
  id: "project-a",
  organizationId: "org-a",
  appTemplateId: "supabase",
  activeDeploymentId: null,
  framework: "docker-compose",
  isApp: true,
} as Project;
const snapshot = {
  serviceDeploymentMode: "services",
  deployTarget: "cloud",
} as DeploymentConfigSnapshot;

beforeEach(() => {
  vi.clearAllMocks();
  h.rows = getAppTemplate("supabase")!.services!.map(
    (s) =>
      ({
        id: `id-${s.name}`,
        projectId: project.id,
        name: s.name,
        kind: "compose",
        enabled: true,
        image: s.image,
        advanced: { stopGracePeriod: "30s" },
      }) as Service,
  );
  h.seed.mockImplementation(
    async (input: { profiles: Array<{ name: string; resources: unknown }> }) => {
      for (const row of h.rows) {
        const profile = input.profiles.find((s) => s.name === row.name);
        if (profile && row.advanced?.resources == null)
          row.advanced = { ...row.advanced, resources: profile.resources } as Service["advanced"];
      }
    },
  );
});

const allocation = async (p = project, s = snapshot) => {
  const mode = await resolveServicePipelineMode(p, s);
  return cloudDockerResources({
    services: mode.servicePreflightServices.map((svc) => ({ resources: svc.advanced?.resources })),
  });
};

describe("retrying an app without rerunning the installer", () => {
  it("does not apply Cloud allocation profiles when retrying a self-hosted install", async () => {
    await allocation(project, { ...snapshot, deployTarget: "server" });
    expect(h.seed).not.toHaveBeenCalled();
    expect(h.rows.every((row) => row.advanced?.resources === undefined)).toBe(true);
  });
  it("repairs a legacy Supabase draft before freezing its deployment allocation", async () => {
    expect(await allocation()).toMatchObject({ cpuCores: 4, memoryMb: 8192, diskMb: 40960 });
    expect(h.seed).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-a",
        organizationId: "org-a",
        appTemplateId: "supabase",
      }),
    );
    expect(h.rows.every((s) => s.advanced?.stopGracePeriod === "30s")).toBe(true);
  });

  it("does not resize an already deployed app or rewrite an explicitly frozen service snapshot", async () => {
    expect((await allocation({ ...project, activeDeploymentId: "release-a" })).cpuCores).toBe(0.25);
    expect(h.seed).not.toHaveBeenCalled();
    const frozen = {
      ...snapshot,
      composeServices: [
        {
          name: "db",
          image: "postgres:17",
          advanced: { resources: { cpuCores: 3, memoryMb: 4096, diskMb: 8192 } },
        },
      ],
    } as DeploymentConfigSnapshot;
    expect((await allocation(project, frozen)).cpuCores).toBe(3);
    expect(h.seed).not.toHaveBeenCalled();
  });
});
