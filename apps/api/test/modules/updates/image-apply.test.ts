import "../mail/_setup-env";
import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  project: { findById: vi.fn() },
  deployment: { findById: vi.fn(), listInFlightByProject: vi.fn() },
  service: { listByProject: vi.fn(), listByDeployment: vi.fn() },
  updateStatus: { upsert: vi.fn(), deleteByProject: vi.fn() },
  fetch: vi.fn(),
  deploy: vi.fn(),
  redeploy: vi.fn(),
}));

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: {
      ...actual.repos,
      project: h.project,
      deployment: h.deployment,
      service: h.service,
      updateStatus: h.updateStatus,
    },
  };
});
vi.mock("@repo/platform/engine/lib/safe-fetch", () => ({ safeFetch: h.fetch }));
vi.mock("@repo/platform/engine/modules/deployments/build.service", () => ({
  redeployBuildSession: h.redeploy,
  triggerDeployment: h.deploy,
}));

import { applyProjectUpdate } from "@repo/platform/engine/modules/updates/updates.service";
import type { ExecutionContext } from "@repo/platform";

const ctx = { organizationId: "org_images", userId: "user_images" } as ExecutionContext;
const OLD = `sha256:${"1".repeat(64)}`;
const NEW = `sha256:${"2".repeat(64)}`;

function setup(
  refs: Array<{ ref: string; digest?: string | null; enabled?: boolean; build?: object }>,
) {
  const project = {
    id: "proj_images",
    organizationId: ctx.organizationId,
    name: "images",
    gitProvider: null,
    gitOwner: null,
    gitRepo: null,
    appTemplateId: null,
    activeDeploymentId: "dep_images",
  };
  h.project.findById.mockResolvedValue(project);
  h.deployment.findById.mockResolvedValue({
    id: project.activeDeploymentId,
    projectId: project.id,
    organizationId: ctx.organizationId,
    environment: "staging",
  });
  h.service.listByProject.mockResolvedValue(
    refs.map((input, i) => ({
      id: `svc_${i}`,
      name: `service-${i}`,
      image: input.ref,
      build: input.build ?? null,
      enabled: input.enabled ?? true,
    })),
  );
  h.service.listByDeployment.mockResolvedValue(
    refs.map((input, i) => ({
      serviceId: `svc_${i}`,
      imageRef: input.ref,
      imageDigest: input.digest === undefined ? OLD : input.digest,
    })),
  );
  return project;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.deployment.listInFlightByProject.mockResolvedValue([]);
  h.deploy.mockResolvedValue({ deployment: { id: "dep_next" } });
  h.fetch.mockImplementation(async (url: string) => {
    if (url.includes("/private/") || url.includes("/host-only/")) {
      return { ok: false, status: 401, headers: {} };
    }
    return { ok: true, status: 200, headers: { "docker-content-digest": NEW } };
  });
});

it.each(["ghcr.io/fixture/published:local", "localhost:5443/fixture/published:stable"])(
  "updates a published %s image without guessing provenance from its name",
  async (ref) => {
    const project = setup([{ ref }]);
    await expect(applyProjectUpdate(ctx, project.id)).resolves.toMatchObject({
      deployment_id: "dep_next",
    });
    expect(h.deploy).toHaveBeenCalledWith(ctx, {
      projectId: project.id,
      environment: "staging",
      trigger: "update",
      serviceIds: ["svc_0"],
      strictServiceScope: true,
    });
    expect(h.redeploy).not.toHaveBeenCalled();
  },
);

it.each([
  { ref: "host-only/custom-app:production", digest: null },
  { ref: "registry.example.test/private/api:1", digest: OLD },
  { ref: "localhost:5000/host-only/remote-app:1", digest: OLD },
])("updates the sidecar without requiring a pull of $ref", async (sibling) => {
  // The local build has no RepoDigest. Private/target-only registries cannot be
  // polled here, but neither case is a reason to block an unrelated image update.
  const project = setup([sibling, { ref: "registry.example.test/public/sidecar:1" }]);
  await expect(applyProjectUpdate(ctx, project.id)).resolves.toMatchObject({
    deployment_id: "dep_next",
  });
  expect(h.deploy).toHaveBeenCalledWith(
    ctx,
    expect.objectContaining({
      serviceIds: ["svc_1"],
      strictServiceScope: true,
    }),
  );
  expect(h.redeploy).not.toHaveBeenCalled();
});

it("targets all changed images together and excludes unchanged, disabled and build services", async () => {
  const project = setup([
    { ref: "registry.example.test/public/api:1" },
    { ref: "registry.example.test/public/worker:1" },
    { ref: "registry.example.test/public/db:1", digest: NEW },
    { ref: "registry.example.test/public/disabled:1", enabled: false },
    { ref: "registry.example.test/public/built:1", build: { context: "." } },
  ]);
  await applyProjectUpdate(ctx, project.id);
  expect(h.deploy).toHaveBeenCalledOnce();
  expect(h.deploy).toHaveBeenCalledWith(
    ctx,
    expect.objectContaining({
      serviceIds: ["svc_0", "svc_1"],
      strictServiceScope: true,
    }),
  );
});

it("does not broaden to a full redeploy when every image is current or unknown", async () => {
  const project = setup([
    { ref: "registry.example.test/private/current:1" },
    { ref: "registry.example.test/public/current:1", digest: NEW },
  ]);
  await expect(applyProjectUpdate(ctx, project.id)).rejects.toThrow("No newer service images");
  expect(h.deploy).not.toHaveBeenCalled();
  expect(h.redeploy).not.toHaveBeenCalled();
});

it("propagates a rejected exact scope without falling back to a full redeploy", async () => {
  const project = setup([{ ref: "registry.example.test/public/deleted:1" }]);
  h.deploy.mockRejectedValueOnce(new Error("selected service was removed"));
  await expect(applyProjectUpdate(ctx, project.id)).rejects.toThrow("selected service was removed");
  expect(h.redeploy).not.toHaveBeenCalled();
});
