/**
 * Deploy preflight's `gpu-target` check, through runPreflightChecks.
 *
 * gpuTargetCheck can decide correctly and still never run: it only matters if the preflight actually
 * calls it with the compose services and the server's manual mark. Same mock shape as
 * preflight-host-capacity.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { getTrustedHostCapacity, getInOrganization } = vi.hoisted(() => ({
  getTrustedHostCapacity: vi.fn(),
  getInOrganization: vi.fn(),
}));

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return { ...actual, repos: { server: { getInOrganization } } };
});
vi.mock("../../../src/lib/controller-helpers", () => ({ platform: () => ({ target: "desktop" }) }));
vi.mock("@repo/platform/engine/lib/platform-config", () => ({
  platform: () => ({ target: "desktop" }),
}));
vi.mock("@repo/platform/engine/lib/resource-access", () => ({
  platform: () => ({ target: "desktop" }),
}));
vi.mock("@repo/platform/engine/lib/cloud/client", () => ({ cloudClient: vi.fn() }));
vi.mock("@repo/platform/engine/lib/cloud/session", () => ({
  isCloudConnectedForOrg: vi.fn().mockResolvedValue(true),
}));
vi.mock("@repo/platform/engine/lib/cloud-preflight", () => ({
  runCloudPreflight: vi.fn().mockResolvedValue({ runtime: { ok: true } }),
}));
vi.mock("@repo/platform/engine/lib/dns-resolver", () => ({
  resolveRecords: vi.fn().mockResolvedValue([]),
  lookupAddresses: vi.fn().mockResolvedValue([]),
}));
vi.mock("@repo/platform/engine/lib/host-capacity", () => ({ getTrustedHostCapacity }));
vi.mock("@repo/platform/engine/modules/apps/catalog-source", () => ({
  getTemplateForOrg: vi.fn().mockResolvedValue(undefined),
}));

import { runPreflightChecks } from "@repo/platform/engine/modules/deployments/preflight";

const snapshot = () =>
  ({
    repoUrl: "",
    localPath: "/srv/rag",
    branch: "main",
    framework: "docker-compose",
    buildImage: null,
    installCommand: null,
    buildCommand: null,
    startCommand: null,
    port: 8000,
    hasBuild: false,
    hasServer: true,
    deployTarget: "server",
    organizationId: "org-1",
    serverId: "srv-1",
  }) as never;

const service = (name: string, advanced?: object) => ({
  kind: "compose",
  name,
  image: "nvidia/cuda:12.4.1-base-ubuntu22.04",
  dependsOn: [],
  environment: {},
  volumes: [],
  exposed: false,
  advanced,
});

const opts = (services: unknown[]) =>
  ({
    ctx: { userId: "user-1", organizationId: "org-1" },
    buildStrategy: "local",
    multiService: true,
    composeServices: services,
    firstDeploy: true,
  }) as never;

const gpuCheck = (r: { checks: { id: string }[] }) => r.checks.find((c) => c.id === "gpu-target");
const GPU = { gpus: { driver: "nvidia", count: "all" } };

describe("preflight gpu-target", () => {
  beforeEach(() => {
    getTrustedHostCapacity.mockReset();
    getInOrganization.mockReset();
    getInOrganization.mockResolvedValue({ id: "srv-1", gpuOverride: null });
    getTrustedHostCapacity.mockResolvedValue({
      cpuCores: 8,
      memoryMb: 32768,
      source: "docker",
      gpuRuntime: false,
    });
  });

  it("warns, and does not refuse, when a GPU service targets a server without one", async () => {
    const result = await runPreflightChecks(snapshot(), opts([service("rag", GPU)]));
    expect(result.ok).toBe(true);
    expect(gpuCheck(result)).toMatchObject({ status: "warn" });
    expect(gpuCheck(result)?.message).toContain('"rag"');
  });

  it("passes when the daemon reports an nvidia runtime", async () => {
    getTrustedHostCapacity.mockResolvedValue({
      cpuCores: 8,
      memoryMb: 32768,
      source: "docker",
      gpuRuntime: true,
      gpuCount: 1,
    });
    const result = await runPreflightChecks(snapshot(), opts([service("rag", GPU)]));
    expect(gpuCheck(result)).toMatchObject({ status: "pass" });
  });

  it("honors the server's manual mark: yes silences the warning on a probe-blind box", async () => {
    getInOrganization.mockResolvedValue({ id: "srv-1", gpuOverride: "yes" });
    const result = await runPreflightChecks(snapshot(), opts([service("rag", GPU)]));
    expect(gpuCheck(result)).toMatchObject({ status: "pass" });
  });

  it("adds no row when no service asks for a GPU, and never probes the box for it", async () => {
    const result = await runPreflightChecks(snapshot(), opts([service("api")]));
    expect(gpuCheck(result)).toBeUndefined();
    expect(getInOrganization).not.toHaveBeenCalled();
  });
});
