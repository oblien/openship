import { beforeEach, describe, expect, it, vi } from "vitest";

const projectRepo = vi.hoisted(() => ({ findById: vi.fn() }));
const serviceRepo = vi.hoisted(() => ({
  findById: vi.fn(),
  findByName: vi.fn(),
  listByProject: vi.fn(),
  listByDeployment: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));
const deploymentRepo = vi.hoisted(() => ({ findById: vi.fn() }));
const domainRepo = vi.hoisted(() => ({ listByProject: vi.fn() }));
const freeGate = vi.hoisted(() => ({ assertFreeEndpointsAllowed: vi.fn() }));

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: {
      ...actual.repos,
      project: projectRepo,
      service: serviceRepo,
      deployment: deploymentRepo,
      domain: domainRepo,
    },
  };
});

vi.mock("../../../src/lib/free-domain-guard", () => freeGate);

const domainService = vi.hoisted(() => ({
  ensurePendingServiceDomain: vi.fn(),
  removeServiceDomain: vi.fn(),
  reuseServerCertForDomain: vi.fn(),
}));
vi.mock("../../../src/modules/domains/domain.service", () => domainService);

/**
 * The route-reconcile block is where a bad routing patch does its REAL damage —
 * it de-registers live vhosts (`removes`) and drops verified domain rows. Both
 * mocks exist so that block actually RUNS: without them `platform()` throws
 * "Platform not initialized", the surrounding catch swallows it, and every
 * assertion below passes vacuously against code that never executed.
 */
const reconcileProjectRoutes = vi.hoisted(() => vi.fn());
vi.mock("../../../src/lib/route-apply.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/route-apply.service")>();
  return { ...actual, reconcileProjectRoutes };
});
vi.mock("../../../src/lib/controller-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/controller-helpers")>();
  return { ...actual, platform: () => ({ runtime: { name: "docker" } }) };
});

import { createService, updateService } from "../../../src/modules/services/service.service";

const ctx = { organizationId: "org_1" } as never;
const project = { id: "proj_1", organizationId: "org_1", slug: "acme" };

/** An app-template service with one route per port (Convex: 3210 + 3211). */
const multiRouteService = () => ({
  id: "svc_1",
  projectId: project.id,
  name: "backend",
  kind: "compose",
  enabled: true,
  environment: {},
  ports: ["3210:3210", "3211:3211"],
  exposed: true,
  exposedPort: "3210",
  domain: "acme-backend",
  customDomain: null,
  domainType: "free",
  publicEndpoints: [
    { port: 3210, domainType: "free", domain: "acme-backend" },
    { port: 3211, domainType: "free", domain: "acme-backend-http" },
  ],
});

const writtenPatch = () => serviceRepo.update.mock.calls.at(-1)?.[1] as Record<string, any>;
const gatedEndpoints = () =>
  freeGate.assertFreeEndpointsAllowed.mock.calls.at(-1)?.[1] as Array<Record<string, unknown>>;

/**
 * A scalar routing patch used to be SHADOWED by the row's stored
 * `publicEndpoints` (the DB normalizer lets a non-empty array win), so a save
 * that switched a service to a custom domain wrote the stored free primary back
 * — and the free-domain cloud gate then 403'd on a route the user never asked
 * for. Collapsing to the scalars instead would delete the sibling routes.
 */
describe("service routing patch", () => {
  beforeEach(() => {
    projectRepo.findById.mockReset().mockResolvedValue(project);
    serviceRepo.findById.mockReset().mockResolvedValue(multiRouteService());
    serviceRepo.findByName.mockReset().mockResolvedValue(null);
    serviceRepo.listByProject.mockReset().mockResolvedValue([]);
    serviceRepo.listByDeployment.mockReset().mockResolvedValue([]);
    serviceRepo.update.mockReset().mockResolvedValue(undefined);
    serviceRepo.create.mockReset().mockImplementation(async (row: Record<string, unknown>) => ({
      id: "svc_new",
      ...row,
    }));
    deploymentRepo.findById.mockReset().mockResolvedValue(null);
    domainRepo.listByProject.mockReset().mockResolvedValue([]);
    freeGate.assertFreeEndpointsAllowed.mockReset().mockResolvedValue(undefined);
    reconcileProjectRoutes.mockReset().mockResolvedValue(undefined);
    domainService.ensurePendingServiceDomain.mockReset().mockResolvedValue({ created: false });
    domainService.removeServiceDomain.mockReset().mockResolvedValue(undefined);
    domainService.reuseServerCertForDomain.mockReset().mockResolvedValue(undefined);
  });

  /** What the edge was asked to stop serving on this save. */
  const removedHosts = () =>
    ((reconcileProjectRoutes.mock.calls.at(-1)?.[1] as { removes?: Array<{ hostname: string }> })
      ?.removes ?? []).map((r) => r.hostname);

  it("persists a scalar custom-domain patch and keeps the sibling route", async () => {
    await updateService(ctx, project.id, "svc_1", {
      domainType: "custom",
      customDomain: "api.example.com",
    } as never);

    const patch = writtenPatch();
    expect(patch.domainType).toBe("custom");
    expect(patch.customDomain).toBe("api.example.com");
    // Switching the primary to custom CLEARS its free slug — `null` writes the
    // column, where `undefined` would leave the stale subdomain behind.
    expect(patch.domain).toBeNull();
    expect(patch.publicEndpoints).toEqual([
      { port: 3210, domainType: "custom", customDomain: "api.example.com" },
      { port: 3211, domainType: "free", domain: "acme-backend-http" },
    ]);
  });

  it("does not gate a custom-domain save on the free routes the row already had", async () => {
    await updateService(ctx, project.id, "svc_1", {
      domainType: "custom",
      customDomain: "api.example.com",
    } as never);

    // The gate sees ONLY what this save introduces — the custom domain (which
    // needs no cloud edge). Before the fix it saw the stored free primary the
    // patch was supposed to replace, plus the untouched free sibling, and 403'd.
    expect(gatedEndpoints()).toEqual([
      { port: 3210, customDomain: "api.example.com", domainType: "custom" },
    ]);
    expect(gatedEndpoints().some((endpoint) => endpoint.domainType === "free")).toBe(false);
  });

  it("adds a route on a new port without dropping the existing ones", async () => {
    await updateService(ctx, project.id, "svc_1", {
      exposed: true,
      exposedPort: "4000",
      domainType: "free",
      domain: "acme-admin",
    } as never);

    expect(writtenPatch().publicEndpoints).toEqual([
      { port: 3210, domainType: "free", domain: "acme-backend" },
      { port: 3211, domainType: "free", domain: "acme-backend-http" },
      { port: 4000, domainType: "free", domain: "acme-admin" },
    ]);
    // The added free subdomain IS net-new, so it does gate.
    expect(gatedEndpoints()).toEqual([{ port: 4000, domain: "acme-admin", domainType: "free" }]);
  });

  it("stops routing on exposed:false without erasing the route config", async () => {
    await updateService(ctx, project.id, "svc_1", { exposed: false } as never);

    const patch = writtenPatch();
    // Unexposed wins over the stored array (it used to be flipped back to true).
    expect(patch.exposed).toBe(false);
    // …but the set is only PAUSED: the same routes are written back unchanged, so
    // re-exposing restores every one of them (and the verified domain rows survive
    // the toggle — removal is keyed on config, not on routing state).
    expect(patch.publicEndpoints).toEqual([
      { port: 3210, domainType: "free", domain: "acme-backend" },
      { port: 3211, domainType: "free", domain: "acme-backend-http" },
    ]);
    expect(patch.customDomain).toBeNull();
    expect(patch.domain).toBe("acme-backend");
  });

  it("restores the whole set on re-expose", async () => {
    serviceRepo.findById.mockResolvedValue({ ...multiRouteService(), exposed: false });

    await updateService(ctx, project.id, "svc_1", { exposed: true } as never);

    const patch = writtenPatch();
    expect(patch.exposed).toBe(true);
    expect(patch.publicEndpoints).toEqual([
      { port: 3210, domainType: "free", domain: "acme-backend" },
      { port: 3211, domainType: "free", domain: "acme-backend-http" },
    ]);
    // Re-exposing what was already configured introduces nothing, so it must not
    // demand a cloud connection.
    expect(gatedEndpoints()).toEqual([]);
  });

  // The three cases below are what an emptied route set actually COSTS, and none of
  // them had any coverage: the edge de-registration and the domain-row drop only run
  // inside the reconcile block, which used to die on an uninitialized platform.

  it("unexposing stops serving every route but keeps the verified domain rows", async () => {
    // The reconcile diffs the row as READ BACK after the write, so the second
    // findById has to reflect it — otherwise the block sees a still-exposed service
    // and computes no removals at all.
    serviceRepo.findById
      .mockResolvedValueOnce(multiRouteService())
      .mockResolvedValueOnce({ ...multiRouteService(), exposed: false });

    await updateService(ctx, project.id, "svc_1", { exposed: false } as never);

    expect(removedHosts().map((h) => h.split(".")[0]).sort()).toEqual([
      "acme-backend",
      "acme-backend-http",
    ]);
    // Config is untouched, so nothing is de-configured — a mere pause must never
    // delete a domain row the operator verified.
    expect(domainService.removeServiceDomain).not.toHaveBeenCalled();
  });

  it("refuses to flip the type with no hostname instead of emptying the set", async () => {
    serviceRepo.findById.mockResolvedValue({
      ...multiRouteService(),
      domain: null,
      customDomain: "api.example.com",
      domainType: "custom",
      publicEndpoints: [
        { port: 3210, domainType: "custom", customDomain: "api.example.com" },
        { port: 3211, domainType: "free", domain: "acme-backend-http" },
      ],
    });

    // Switching a custom primary to "free" without a subdomain used to resolve to
    // an empty set: HTTP 200, both vhosts de-registered, and the verified domain
    // row for api.example.com deleted.
    await expect(
      updateService(ctx, project.id, "svc_1", { domainType: "free" } as never),
    ).rejects.toThrow(/free route needs a subdomain/i);

    expect(serviceRepo.update).not.toHaveBeenCalled();
    expect(reconcileProjectRoutes).not.toHaveBeenCalled();
    expect(domainService.removeServiceDomain).not.toHaveBeenCalled();
  });

  it("refuses a cleared subdomain instead of dropping the sibling route", async () => {
    await expect(
      updateService(ctx, project.id, "svc_1", { domain: "" } as never),
    ).rejects.toThrow(/free route needs a subdomain/i);

    expect(serviceRepo.update).not.toHaveBeenCalled();
    expect(reconcileProjectRoutes).not.toHaveBeenCalled();
  });

  it("clears the routes when the payload explicitly sends an empty array", async () => {
    await updateService(ctx, project.id, "svc_1", {
      exposed: false,
      publicEndpoints: [],
    } as never);

    expect(writtenPatch().publicEndpoints).toEqual([]);
  });

  it("gates a free route at CREATE time, before the row is written", async () => {
    freeGate.assertFreeEndpointsAllowed.mockRejectedValue(new Error("cloud-required"));

    await expect(
      createService(ctx, project.id, {
        name: "web",
        image: "nginx",
        ports: ["8080:80"],
        exposed: true,
        exposedPort: "80",
        domainType: "free",
        domain: "acme-web",
      } as never),
    ).rejects.toThrow("cloud-required");

    expect(gatedEndpoints()).toEqual([{ port: 80, domain: "acme-web", domainType: "free" }]);
    expect(serviceRepo.create).not.toHaveBeenCalled();
  });

  it("creates a custom-domain service without demanding cloud", async () => {
    await createService(ctx, project.id, {
      name: "web",
      image: "nginx",
      ports: ["8080:80"],
      exposed: true,
      exposedPort: "80",
      domainType: "custom",
      customDomain: "web.example.com",
    } as never);

    expect(gatedEndpoints()).toEqual([
      { port: 80, customDomain: "web.example.com", domainType: "custom" },
    ]);
    expect(serviceRepo.create).toHaveBeenCalled();
  });

  // #424: a container answers to BOTH its name and its custom alias on the
  // project network, so every write path (create name, rename, alias, project
  // internalAlias) must reject a value already taken by any of those. The old
  // name path was an exact `findByName` — blind to sibling aliases, to the
  // internalAlias, and to normalization.
  describe("east-west hostname collisions", () => {
    it("create: a name equal to a sibling's custom alias is rejected", async () => {
      serviceRepo.listByProject.mockResolvedValue([
        { id: "svc_2", name: "redis", advanced: { alias: "cache" } },
      ]);

      await expect(
        createService(ctx, project.id, { name: "cache", image: "redis" } as never),
      ).rejects.toThrow("service-name-already-exists");
      expect(serviceRepo.create).not.toHaveBeenCalled();
    });

    it("rename: a new name equal to a sibling's custom alias is rejected", async () => {
      serviceRepo.listByProject.mockResolvedValue([
        { id: "svc_2", name: "redis", advanced: { alias: "cache" } },
      ]);

      await expect(
        updateService(ctx, project.id, "svc_1", { name: "cache" } as never),
      ).rejects.toThrow("service-name-already-exists");
      expect(serviceRepo.update).not.toHaveBeenCalled();
    });

    it("create: a name equal to the project's internalAlias is rejected", async () => {
      projectRepo.findById.mockResolvedValue({ ...project, internalAlias: "cache" });
      serviceRepo.listByProject.mockResolvedValue([]);

      await expect(
        createService(ctx, project.id, { name: "cache", image: "redis" } as never),
      ).rejects.toThrow("service-name-already-exists");
      expect(serviceRepo.create).not.toHaveBeenCalled();
    });

    it("create: a normalized-duplicate name is rejected (\"My DB\" vs \"my-db\")", async () => {
      serviceRepo.listByProject.mockResolvedValue([{ id: "svc_2", name: "My DB" }]);

      await expect(
        createService(ctx, project.id, { name: "my-db", image: "postgres" } as never),
      ).rejects.toThrow("service-name-already-exists");
      expect(serviceRepo.create).not.toHaveBeenCalled();
    });

    it("update alias: a custom alias equal to a sibling's name/alias is rejected", async () => {
      serviceRepo.listByProject.mockResolvedValue([
        { id: "svc_2", name: "redis", advanced: { alias: "cache" } },
      ]);

      await expect(
        updateService(ctx, project.id, "svc_1", { advanced: { alias: "cache" } } as never),
      ).rejects.toThrow("service-alias-conflict");
      expect(serviceRepo.update).not.toHaveBeenCalled();
    });

    it("update alias: a value with no usable DNS characters is rejected", async () => {
      await expect(
        updateService(ctx, project.id, "svc_1", { advanced: { alias: "!!!" } } as never),
      ).rejects.toThrow("service-alias-invalid");
      expect(serviceRepo.update).not.toHaveBeenCalled();
    });

    it("self-edit: re-saving a service's OWN alias never reports a collision", async () => {
      // Only the edited row is on the project; it already carries alias "gw". The
      // gate must exclude self (s.id !== serviceId), so this is a clean no-op save.
      serviceRepo.findById.mockResolvedValue({
        ...multiRouteService(),
        advanced: { alias: "gw" },
      });
      serviceRepo.listByProject.mockResolvedValue([
        { id: "svc_1", name: "backend", advanced: { alias: "gw" } },
      ]);

      await expect(
        updateService(ctx, project.id, "svc_1", { advanced: { alias: "gw" } } as never),
      ).resolves.toBeDefined();
      expect(serviceRepo.update).toHaveBeenCalled();
    });
  });
});
