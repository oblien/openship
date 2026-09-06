import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Installing a stateful app should leave it with backups attached — that is the
 * feature. But the install is what the user is actually waiting on, so the
 * wiring has a second requirement that matters just as much: a backup problem
 * must never turn a successful install into a failed one. The project, its
 * services and its env are already persisted by the time this runs.
 */

const {
  createProjectMock,
  createServiceMock,
  setEnvMock,
  requireCloudMock,
  draftMock,
  applyDefaultsMock,
} = vi.hoisted(() => ({
  createProjectMock: vi.fn(),
  createServiceMock: vi.fn(),
  setEnvMock: vi.fn(),
  requireCloudMock: vi.fn(),
  draftMock: vi.fn(),
  applyDefaultsMock: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    project: {
      findDraftByAppTemplate: draftMock,
      // installApp runs `ensureGeneratedAppSecrets` just before the backup step;
      // nothing here asserts on it, it only has to not throw.
      getEnvMap: async () => ({}),
      mergeEnvVars: async () => {},
    },
    service: {
      listByProject: async () => [{ id: "svc-n8n", name: "n8n" }],
    },
    customAppTemplate: {
      findByAppId: async () => undefined,
      listByOrg: async () => [],
    },
  },
}));

vi.mock("../../../src/modules/projects/project-crud.service", () => ({
  createProject: createProjectMock,
}));

vi.mock("../../../src/modules/services/service.service", () => ({
  createService: createServiceMock,
  updateService: vi.fn(),
  setServiceEnvVars: setEnvMock,
}));

vi.mock("../../../src/lib/cloud/require-cloud", () => ({
  requireCloud: requireCloudMock,
}));

vi.mock("../../../src/modules/backups/apply-defaults.service", () => ({
  applyBackupDefaults: applyDefaultsMock,
}));

import { installApp } from "../../../src/modules/apps/app-install.service";
import type { RequestContext } from "../../../src/lib/request-context";

const ctx = { organizationId: "org1", userId: "u1" } as RequestContext;

beforeEach(() => {
  vi.clearAllMocks();
  draftMock.mockResolvedValue(undefined);
  createProjectMock.mockResolvedValue({ id: "p1", slug: "n8n", name: "n8n" });
  createServiceMock.mockResolvedValue({ id: "svc" });
  setEnvMock.mockResolvedValue(undefined);
  requireCloudMock.mockResolvedValue(undefined);
  applyDefaultsMock.mockResolvedValue({ applied: 1, skipped: 0, services: ["n8n"] });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
});

describe("app install — backup defaults", () => {
  it("applies the template's defaults after the services exist", async () => {
    const result = await installApp(ctx, { templateId: "n8n", name: "n8n" });

    expect(result).toMatchObject({ kind: "template", projectId: "p1" });
    expect(applyDefaultsMock).toHaveBeenCalledTimes(1);
    const [, projectId, template] = applyDefaultsMock.mock.calls[0];
    expect(projectId).toBe("p1");
    expect(template.id).toBe("n8n");
    // Ordering is load-bearing: the applier resolves service NAMES to row ids,
    // so it can only run once the install has created them.
    expect(createServiceMock).toHaveBeenCalled();
  });

  it("passes an explicitly chosen destination through", async () => {
    await installApp(ctx, { templateId: "n8n", backupDestinationId: "dst-1" });

    expect(applyDefaultsMock.mock.calls[0][3]).toEqual({ destinationId: "dst-1" });
  });

  it("opts out when the caller says applyBackupDefaults: false", async () => {
    await installApp(ctx, { templateId: "n8n", applyBackupDefaults: false });

    expect(applyDefaultsMock).not.toHaveBeenCalled();
  });

  it("still succeeds when applying defaults throws", async () => {
    // The whole reason this is wrapped: the app is installed and running. A
    // backup failure here is worth logging, not worth telling the user their
    // install failed and leaving them to guess what state the project is in.
    applyDefaultsMock.mockRejectedValue(new Error("destination unreachable"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await installApp(ctx, { templateId: "n8n" });

    expect(result).toMatchObject({ kind: "template", projectId: "p1" });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("does not touch backups for a flow app", async () => {
    const result = await installApp(ctx, { templateId: "mail" });

    expect(result.kind).toBe("flow");
    expect(applyDefaultsMock).not.toHaveBeenCalled();
  });
});
