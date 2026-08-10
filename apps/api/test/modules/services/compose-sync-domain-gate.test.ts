import { beforeEach, describe, expect, it, vi } from "vitest";

const projectRepo = vi.hoisted(() => ({ findById: vi.fn() }));
const serviceRepo = vi.hoisted(() => ({ listByProject: vi.fn(), syncFromCompose: vi.fn() }));

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: { ...actual.repos, project: projectRepo, service: serviceRepo },
  };
});

import { syncComposeServices } from "../../../src/modules/services/service.service";

/**
 * #342 follow-through: the create/update service editors have always shape-checked a
 * custom hostname (`normalizeRoutingPatch`), but `POST /projects/:id/services/sync`
 * wrote the routing columns straight through `syncFromCompose`. A compose service's
 * custom domain becomes a vhost exactly like the project's own, so the import path
 * needs the same gate — with the same net-new exemption, or a project holding a bad
 * hostname from before the gate could never re-sync its compose file again.
 */
const ctx = { organizationId: "org_1" } as never;
const project = { id: "proj_1", organizationId: "org_1" };

const service = (over: Record<string, unknown> = {}) => ({
  name: "web",
  image: "nginx",
  exposed: true,
  exposedPort: "8080",
  domainType: "custom" as const,
  customDomain: "app.example.com",
  ...over,
});

describe("syncComposeServices custom-hostname gate", () => {
  beforeEach(() => {
    projectRepo.findById.mockReset().mockResolvedValue(project);
    serviceRepo.listByProject.mockReset().mockResolvedValue([]);
    serviceRepo.syncFromCompose.mockReset().mockResolvedValue([]);
  });

  for (const customDomain of ["localhost", "127.0.0.1", "single", "example.com:8080"]) {
    it(`refuses ${JSON.stringify(customDomain)} without writing`, async () => {
      await expect(
        syncComposeServices(ctx, project.id, [service({ customDomain })]),
      ).rejects.toThrow(/is not a valid custom domain/);

      expect(serviceRepo.syncFromCompose).not.toHaveBeenCalled();
    });
  }

  it("refuses a bogus hostname on a service's secondary route", async () => {
    await expect(
      syncComposeServices(ctx, project.id, [
        service({
          customDomain: undefined,
          domainType: undefined,
          publicEndpoints: [
            { customDomain: "api.example.com", domainType: "custom" },
            { customDomain: "localhost", domainType: "custom" },
          ],
        }),
      ]),
    ).rejects.toThrow(/"localhost"/);

    expect(serviceRepo.syncFromCompose).not.toHaveBeenCalled();
  });

  it("accepts real hostnames", async () => {
    await syncComposeServices(ctx, project.id, [service()]);
    expect(serviceRepo.syncFromCompose).toHaveBeenCalled();
  });

  it("still syncs a project whose stored row already carries a bad hostname", async () => {
    serviceRepo.listByProject.mockResolvedValue([
      { name: "web", environment: {}, domainType: "custom", customDomain: "localhost" },
    ]);

    await syncComposeServices(ctx, project.id, [service({ customDomain: "localhost" })]);

    expect(serviceRepo.syncFromCompose).toHaveBeenCalled();
  });

  it("refuses a DIFFERENT bad hostname on that same project", async () => {
    serviceRepo.listByProject.mockResolvedValue([
      { name: "web", environment: {}, domainType: "custom", customDomain: "localhost" },
    ]);

    await expect(
      syncComposeServices(ctx, project.id, [service({ customDomain: "127.0.0.1" })]),
    ).rejects.toThrow(/"127.0.0.1"/);
  });

  // A free-routed service never stores `customDomain`, so a leftover value there is
  // dropped rather than routed — failing it would reject harmless payloads.
  it("ignores a customDomain left on a free-routed service", async () => {
    await syncComposeServices(ctx, project.id, [
      service({ domainType: "free", domain: "web", customDomain: "localhost" }),
    ]);

    expect(serviceRepo.syncFromCompose).toHaveBeenCalled();
  });
});
