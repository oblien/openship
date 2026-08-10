import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * App install must persist EXACTLY the routing the operator chose — never a
 * fabricated free subdomain. The installer used to seed one `domainType:"free"`
 * endpoint per templated route, so a custom-domain (or port-only) install landed
 * on *.opsh.io routes the user never asked for and then 403'd when the wizard
 * tried to correct them after the fact.
 */

const { createProjectMock, createServiceMock, setEnvMock, requireCloudMock, draftMock } = vi.hoisted(
  () => ({
    createProjectMock: vi.fn(),
    createServiceMock: vi.fn(),
    setEnvMock: vi.fn(),
    requireCloudMock: vi.fn(),
    draftMock: vi.fn(),
  }),
);

vi.mock("@repo/db", () => ({
  repos: {
    project: { findDraftByAppTemplate: draftMock },
    service: {
      listByProject: async () => [
        { id: "svc-backend", name: "backend" },
        { id: "svc-dashboard", name: "dashboard" },
      ],
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
  setServiceEnvVars: setEnvMock,
}));

vi.mock("../../../src/lib/cloud/require-cloud", () => ({
  requireCloud: requireCloudMock,
}));

import {
  installApp,
  planInstallRouting,
  type InstallAppRoute,
} from "../../../src/modules/apps/app-install.service";
import type { RequestContext } from "../../../src/lib/request-context";

const ctx = { organizationId: "org1", userId: "u1" } as RequestContext;

/** The createService payload for one service name. */
const payloadFor = (name: string) =>
  createServiceMock.mock.calls.find((c) => c[2]?.name === name)?.[2] as
    | {
        exposed: boolean;
        domainType?: "free" | "custom";
        publicEndpoints: Array<{
          port: number;
          domainType: "free" | "custom";
          domain?: string;
          customDomain?: string;
        }>;
      }
    | undefined;

const install = (routes?: InstallAppRoute[]) =>
  installApp(ctx, { templateId: "convex", name: "Convex", routes });

beforeEach(() => {
  vi.clearAllMocks();
  draftMock.mockResolvedValue(undefined);
  createProjectMock.mockResolvedValue({ id: "p1", slug: "convex", name: "Convex" });
  createServiceMock.mockResolvedValue({ id: "svc" });
  setEnvMock.mockResolvedValue(undefined);
  requireCloudMock.mockResolvedValue(undefined);
  // The catalog overlay refresh is fire-and-forget; keep it off the network.
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
});

describe("app install — routing comes from the operator's choice", () => {
  it("persists a custom domain and NO free route for the chosen endpoint", async () => {
    await install([
      { service: "backend", port: 3210, mode: "custom", customDomain: "API.Example.com" },
      { service: "dashboard", port: 6791, mode: "port" },
    ]);

    const backend = payloadFor("backend")!;
    expect(backend.exposed).toBe(true);
    expect(backend.domainType).toBe("custom");
    expect(backend.publicEndpoints).toEqual([
      { port: 3210, domainType: "custom", customDomain: "api.example.com" },
    ]);

    // Port-only: nothing public is persisted, so the deploy's free-domain gate
    // has nothing to trip on.
    const dashboard = payloadFor("dashboard")!;
    expect(dashboard.exposed).toBe(false);
    expect(dashboard.publicEndpoints).toEqual([]);
  });

  it("invents nothing when the caller sends no routing", async () => {
    await install();
    for (const name of ["backend", "dashboard"]) {
      const payload = payloadFor(name)!;
      expect(payload.exposed).toBe(false);
      expect(payload.publicEndpoints).toEqual([]);
      expect(payload.domainType).toBeUndefined();
    }
    expect(requireCloudMock).not.toHaveBeenCalled();
  });

  it("uses the template's default label only when free was explicitly chosen", async () => {
    await install([{ service: "backend", port: 3210, mode: "free" }]);
    // ONLY the chosen port. The declared secondary (Convex's HTTP-actions 3211)
    // gets its own wizard picker via `declaredServiceRoutes`, so it is never minted
    // behind the operator; left unchosen it has no hostname at all, and
    // `{{publicUrl:backend:3211}}` resolves to the published host:port instead.
    expect(payloadFor("backend")!.publicEndpoints).toEqual([
      { port: 3210, domainType: "free", domain: "convex-backend" },
    ]);
    expect(payloadFor("dashboard")!.exposed).toBe(false);
  });

  it("honors a typed slug, and labels a separately chosen secondary from the template", async () => {
    await install([
      { service: "backend", port: 3210, mode: "free", domain: "MyConvex" },
      { service: "backend", port: 3211, mode: "free" },
    ]);
    // Declared order decides which route is primary (entry[0] mirrors the scalar
    // columns), regardless of the order the choices arrive in.
    expect(payloadFor("backend")!.publicEndpoints).toEqual([
      { port: 3210, domainType: "free", domain: "myconvex" },
      { port: 3211, domainType: "free", domain: "convex-backend-http" },
    ]);
  });

  it("gates a chosen free route on Openship Cloud BEFORE anything is written", async () => {
    requireCloudMock.mockRejectedValue(new Error("cloud-required"));
    await expect(install([{ service: "backend", port: 3210, mode: "free" }])).rejects.toThrow(
      /cloud-required/,
    );
    expect(createProjectMock).not.toHaveBeenCalled();
    expect(createServiceMock).not.toHaveBeenCalled();
    expect(requireCloudMock).toHaveBeenCalledWith("managed-project-domain", {
      organizationId: "org1",
    });
  });

  it("refuses a custom choice with no hostname, writing nothing", async () => {
    await expect(
      install([{ service: "backend", port: 3210, mode: "custom", customDomain: "  " }]),
    ).rejects.toThrow(/Enter the domain/i);
    expect(createProjectMock).not.toHaveBeenCalled();
  });

  it("refuses routing for a service or port the app doesn't serve", async () => {
    await expect(install([{ service: "nope", port: 3210, mode: "port" }])).rejects.toThrow(
      /no service named/i,
    );
    await expect(install([{ service: "backend", port: 9999, mode: "free" }])).rejects.toThrow(
      /doesn't serve port 9999/i,
    );
    expect(createProjectMock).not.toHaveBeenCalled();
  });
});

describe("planInstallRouting", () => {
  const template = {
    services: [
      {
        name: "minio",
        image: "minio",
        exposedPort: 9001,
        exposed: true,
        routes: [{ port: 9001 }, { port: 9000, slugSuffix: "s3" }],
      },
      { name: "db", image: "pg", exposed: false, ports: ["5432:5432"] },
    ],
  };

  it("keeps each chosen port's own hostname, in declared order", () => {
    const plan = planInstallRouting(template, "store", [
      { service: "minio", port: 9000, mode: "custom", customDomain: "s3.example.com" },
      { service: "minio", port: 9001, mode: "free", domain: "console" },
    ]);
    expect(plan.get("minio")).toEqual({
      exposed: true,
      publicEndpoints: [
        { port: 9001, domainType: "free", domain: "console" },
        { port: 9000, domainType: "custom", customDomain: "s3.example.com" },
      ],
    });
  });

  it("gives a secondary route no hostname when the primary is custom", () => {
    const plan = planInstallRouting(template, "store", [
      { service: "minio", port: 9001, mode: "custom", customDomain: "console.example.com" },
    ]);
    expect(plan.get("minio")!.publicEndpoints).toEqual([
      { port: 9001, domainType: "custom", customDomain: "console.example.com" },
    ]);
  });

  it("leaves an unmentioned service unexposed", () => {
    const plan = planInstallRouting(template, "store", []);
    expect(plan.get("db")).toEqual({ exposed: false, publicEndpoints: [] });
    expect(plan.get("minio")).toEqual({ exposed: false, publicEndpoints: [] });
  });
});
