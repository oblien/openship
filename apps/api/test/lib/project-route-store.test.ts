import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError } from "@repo/core";

const domainRepo = vi.hoisted(() => ({
  update: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
  listByProject: vi.fn(),
  findByHostname: vi.fn(),
}));

const projectRepo = vi.hoisted(() => ({
  findById: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    domain: domainRepo,
    project: projectRepo,
  },
}));

// checkManagedSlugAvailable calls platform().runtime and only does anything for
// a CloudRuntime; a plain object is not one, so it returns null (local-DB path)
// instead of getPlatform() throwing "Platform not initialized" under vitest.
vi.mock("../../src/lib/controller-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/controller-helpers")>();
  return { ...actual, platform: () => ({ runtime: {} }) };
});

import { getRoutingBaseDomain } from "../../src/lib/routing-domains";
import { syncProjectPublicRoutes } from "../../src/lib/project-route-store";

describe("syncProjectPublicRoutes", () => {
  beforeEach(() => {
    domainRepo.update.mockReset();
    domainRepo.create.mockReset();
    domainRepo.remove.mockReset();
    domainRepo.listByProject.mockReset();
    domainRepo.findByHostname.mockReset();
    projectRepo.findById.mockReset();
    domainRepo.create.mockImplementation(async (data: any) => ({
      id: "dom_created",
      ...data,
    }));
  });

  it("reuses an existing service-scoped hostname when switching to project-level routing", async () => {
    const hostname = `business-servio.${getRoutingBaseDomain()}`;

    await syncProjectPublicRoutes({
      projectId: "proj_123",
      endpoints: [{
        port: 7000,
        domain: "business-servio",
        domainType: "free",
      }],
      currentDomains: [{
        id: "dom_service",
        projectId: "proj_123",
        serviceId: "svc_business",
        hostname,
        targetPort: 7000,
        targetPath: null,
        domainType: "free",
        isPrimary: false,
        verified: true,
        status: "active",
      } as any],
    });

    expect(domainRepo.create).not.toHaveBeenCalled();
    expect(domainRepo.remove).not.toHaveBeenCalled();
    expect(domainRepo.update).toHaveBeenCalledWith("dom_service", {
      serviceId: null,
      isPrimary: true,
    });
  });

  it("dedupes repeated hostnames from the desired endpoint list", async () => {
    const hostname = `business-servio.${getRoutingBaseDomain()}`;

    await syncProjectPublicRoutes({
      projectId: "proj_123",
      endpoints: [
        {
          port: 7000,
          domain: "business-servio",
          domainType: "free",
        },
        {
          port: 7000,
          domain: "business-servio",
          domainType: "free",
        },
      ],
      currentDomains: [],
    });

    expect(domainRepo.create).toHaveBeenCalledTimes(1);
    expect(domainRepo.create).toHaveBeenCalledWith(expect.objectContaining({
      hostname,
      serviceId: null,
      targetPort: 7000,
      isPrimary: true,
    }));
    expect(domainRepo.update).not.toHaveBeenCalled();
    expect(domainRepo.remove).not.toHaveBeenCalled();
  });

  it("throws a conflict when the hostname already belongs to another project", async () => {
    const hostname = `business-servio.${getRoutingBaseDomain()}`;
    // The conflicting row's owner project still exists → a real conflict
    // (resolveLocalConflict returns the row instead of treating it as an orphan).
    projectRepo.findById.mockResolvedValue({ id: "proj_other" });
    domainRepo.findByHostname.mockResolvedValue({
      id: "dom_other",
      projectId: "proj_other",
      serviceId: null,
      hostname,
      targetPort: 7000,
      targetPath: null,
      domainType: "free",
      isPrimary: true,
      verified: true,
      status: "active",
    });

    await expect(syncProjectPublicRoutes({
      projectId: "proj_123",
      endpoints: [{
        port: 7000,
        domain: "business-servio",
        domainType: "free",
      }],
      currentDomains: [],
    })).rejects.toBeInstanceOf(ConflictError);

    expect(domainRepo.create).not.toHaveBeenCalled();
    expect(domainRepo.update).not.toHaveBeenCalled();
    expect(domainRepo.remove).not.toHaveBeenCalled();
  });

  // The endpoints list is what routing reconciles against, so a redirect has to
  // survive the whole trip: submitted endpoint → normalize → domain row. Every
  // link is a field-by-field copy, so any one of them dropping it means the UI
  // shows a redirect and the edge serves the app.
  describe("canonical redirects", () => {
    const apex = {
      id: "dom_apex",
      projectId: "proj_123",
      serviceId: null,
      hostname: "example.com",
      targetPort: 3000,
      targetPath: null,
      domainType: "custom",
      isPrimary: true,
      verified: true,
      status: "active",
      redirectTo: null,
      redirectStatus: null,
    };

    it("persists redirectTo + redirectStatus on a NEW row", async () => {
      await syncProjectPublicRoutes({
        projectId: "proj_123",
        endpoints: [
          { port: 3000, customDomain: "example.com", domainType: "custom" },
          {
            port: 3000,
            customDomain: "www.example.com",
            domainType: "custom",
            redirectTo: "example.com",
            redirectStatus: 301,
          },
        ],
        currentDomains: [apex],
      });

      const created = domainRepo.create.mock.calls.map(([data]: [any]) => data);
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({
        hostname: "www.example.com",
        redirectTo: "example.com",
        redirectStatus: 301,
      });
    });

    it("CLEARS a redirect the submitted list omits — that's how you stop redirecting", async () => {
      await syncProjectPublicRoutes({
        projectId: "proj_123",
        endpoints: [{ port: 3000, customDomain: "www.example.com", domainType: "custom" }],
        currentDomains: [
          {
            ...apex,
            id: "dom_www",
            hostname: "www.example.com",
            isPrimary: true,
            redirectTo: "example.com",
            redirectStatus: 301,
          },
        ],
      });

      expect(domainRepo.update).toHaveBeenCalledWith(
        "dom_www",
        expect.objectContaining({ redirectTo: null, redirectStatus: null }),
      );
    });

    // Refused BEFORE any row is written: once the loop is on disk the edge serves
    // it, and every request to either hostname bounces until the browser gives up.
    it("REFUSES a loop without writing anything", async () => {
      await expect(
        syncProjectPublicRoutes({
          projectId: "proj_123",
          endpoints: [
            {
              port: 3000,
              customDomain: "example.com",
              domainType: "custom",
              redirectTo: "www.example.com",
            },
            {
              port: 3000,
              customDomain: "www.example.com",
              domainType: "custom",
              redirectTo: "example.com",
            },
          ],
          currentDomains: [apex],
        }),
      ).rejects.toThrow(/redirect loop/);

      expect(domainRepo.create).not.toHaveBeenCalled();
      expect(domainRepo.update).not.toHaveBeenCalled();
      expect(domainRepo.remove).not.toHaveBeenCalled();
    });

    it("REFUSES a target that isn't one of the project's own hostnames", async () => {
      await expect(
        syncProjectPublicRoutes({
          projectId: "proj_123",
          endpoints: [
            {
              port: 3000,
              customDomain: "example.com",
              domainType: "custom",
              redirectTo: "somewhere-else.test",
            },
          ],
          currentDomains: [apex],
        }),
      ).rejects.toThrow(/only redirect to another domain of this project/);
    });
  });

  // Fix 2b: a DEPLOY (flag on) that mis-resolved its target must never erase a
  // user's proven custom domain — the nulling/removal that regressed the Access URL
  // to localhost. The Domains EDITOR (flag off) keeps full authority to remove/edit.
  describe("preserveVerifiedCustom", () => {
    const verifiedCustom = {
      id: "dom_api",
      projectId: "proj_123",
      serviceId: null,
      hostname: "api.openship.io",
      targetPort: 4000,
      targetPath: null,
      domainType: "custom",
      isPrimary: true,
      verified: true,
      status: "active",
      redirectTo: null,
      redirectStatus: null,
    } as any;

    it("KEEPS a verified custom domain the deploy's endpoint set omits", async () => {
      await syncProjectPublicRoutes({
        projectId: "proj_123",
        // Deploy resolved to only the free route; the custom domain is absent.
        endpoints: [{ port: 3000, domain: "myapp", domainType: "free" }],
        currentDomains: [verifiedCustom],
        preserveVerifiedCustom: true,
      });

      expect(domainRepo.remove).not.toHaveBeenCalled();
    });

    it("REMOVES that same omitted custom domain for the editor (flag off)", async () => {
      await syncProjectPublicRoutes({
        projectId: "proj_123",
        endpoints: [{ port: 3000, domain: "myapp", domainType: "free" }],
        currentDomains: [verifiedCustom],
        // preserveVerifiedCustom omitted → editor authority.
      });

      expect(domainRepo.remove).toHaveBeenCalledWith("dom_api");
    });

    it("does NOT protect an UNVERIFIED custom domain — the guard is verified-only", async () => {
      await syncProjectPublicRoutes({
        projectId: "proj_123",
        endpoints: [{ port: 3000, domain: "myapp", domainType: "free" }],
        currentDomains: [{ ...verifiedCustom, verified: false, status: "pending" }],
        preserveVerifiedCustom: true,
      });

      expect(domainRepo.remove).toHaveBeenCalledWith("dom_api");
    });

    it("does NOT protect a FREE domain — the guard is custom-only", async () => {
      await syncProjectPublicRoutes({
        projectId: "proj_123",
        endpoints: [{ port: 3000, customDomain: "api.openship.io", domainType: "custom" }],
        currentDomains: [{
          ...verifiedCustom,
          id: "dom_free",
          hostname: "old-slug.opsh.io",
          domainType: "free",
        }],
        preserveVerifiedCustom: true,
      });

      expect(domainRepo.remove).toHaveBeenCalledWith("dom_free");
    });

    // The update-branch guard, isolated: the same portless desired route flips the
    // live port between "kept" and "nulled" purely on the flag. A deploy that
    // resolved without this domain's port must leave the proven upstream intact.
    it("does NOT null a verified custom domain's port when the deploy omits it (flag on)", async () => {
      await syncProjectPublicRoutes({
        projectId: "proj_123",
        // Desired route survives normalization (has a path) but carries no port.
        endpoints: [{ targetPath: "/api", customDomain: "api.openship.io", domainType: "custom" }],
        currentDomains: [verifiedCustom],
        preserveVerifiedCustom: true,
      });

      const patch = domainRepo.update.mock.calls.find(([id]: [string]) => id === "dom_api")?.[1] as
        | Record<string, unknown>
        | undefined;
      expect(patch && "targetPort" in patch).toBeFalsy();
    });

    it("DOES null that port for the editor (flag off)", async () => {
      await syncProjectPublicRoutes({
        projectId: "proj_123",
        endpoints: [{ targetPath: "/api", customDomain: "api.openship.io", domainType: "custom" }],
        currentDomains: [verifiedCustom],
      });

      expect(domainRepo.update).toHaveBeenCalledWith(
        "dom_api",
        expect.objectContaining({ targetPort: null }),
      );
    });
  });
});