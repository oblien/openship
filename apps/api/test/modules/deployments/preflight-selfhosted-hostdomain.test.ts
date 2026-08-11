import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #427 follow-up — a self-hosted box with its own HOST_DOMAIN.
 *
 * `getRoutingBaseDomain() = HOST_DOMAIN || CLOUD_DOMAIN`, so on an operator's own
 * domain a free service subdomain composes to `<slug>.<HOST_DOMAIN>` — served by
 * the operator's OWN edge, NOT the Cloud edge (only `*.opsh.io` needs Cloud).
 * The per-service preflight check used a raw `if (!cloud)` that 403'd EVERY free
 * subdomain regardless of base; it now gates on `isCloudManagedHostname(fqdn)`,
 * so this route deploys with no Cloud connection.
 *
 * `env` is parsed once at import (config/env.ts), so HOST_DOMAIN can't be set
 * inline. We set it in `process.env` from a `vi.hoisted` block — which runs BEFORE
 * the hoisted module imports evaluate — so the REAL env carries it and the REAL
 * `getRoutingBaseDomain()` returns it consistently for EVERY importer (preflight.ts
 * AND public-endpoints.ts). Mocking routing-domains instead only rebinds some
 * importers, leaving public-endpoints on the real "opsh.io" base.
 */

vi.hoisted(() => {
  process.env.HOST_DOMAIN = "apps.example.com";
});

const { cloudClient, runCloudPreflight, preflightFn } = vi.hoisted(() => ({
  cloudClient: vi.fn(),
  runCloudPreflight: vi.fn(),
  preflightFn: vi.fn(),
}));

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return { ...actual, repos: {} };
});

vi.mock("../../../src/lib/controller-helpers", () => ({
  platform: () => ({ target: "desktop" }),
}));

vi.mock("../../../src/lib/cloud/client", () => ({ cloudClient }));

vi.mock("../../../src/lib/cloud/session", () => ({
  isCloudConnectedForOrg: vi.fn().mockResolvedValue(false),
}));

vi.mock("../../../src/lib/cloud-preflight", () => ({ runCloudPreflight }));

vi.mock("../../../src/lib/dns-resolver", () => ({
  resolveRecords: vi.fn().mockResolvedValue([]),
  lookupAddresses: vi.fn().mockResolvedValue([]),
}));

import { runPreflightChecks } from "../../../src/modules/deployments/preflight";

// process.env is process-global; a reused worker could carry HOST_DOMAIN into a
// later file's fresh env parse. This file's own env is already parsed, so the
// delete only shields subsequent files.
afterAll(() => {
  delete process.env.HOST_DOMAIN;
});

describe("runPreflightChecks — self-hosted HOST_DOMAIN (#427 follow-up)", () => {
  beforeEach(() => {
    runCloudPreflight.mockReset();
    cloudClient.mockReset();
    preflightFn.mockReset();
    // No cloud connection at all: the bridge returns no data.
    preflightFn.mockResolvedValue(null);
    cloudClient.mockReturnValue({ preflight: preflightFn } as any);
    runCloudPreflight.mockResolvedValue(null);
  });

  it("does NOT require cloud for a free subdomain on the operator's own HOST_DOMAIN", async () => {
    const result = await runPreflightChecks(
      {
        repoUrl: "",
        localPath: "/srv/my-stack",
        branch: "main",
        framework: "docker-compose",
        buildImage: null,
        installCommand: null,
        buildCommand: null,
        startCommand: null,
        port: 3000,
        hasBuild: true,
        hasServer: true,
        deployTarget: "server",
        organizationId: "org-1",
      } as any,
      {
        ctx: { userId: "user-1", organizationId: "org-1" } as any,
        buildStrategy: "local",
        multiService: true,
        composeServices: [
          {
            kind: "compose",
            name: "web",
            build: ".",
            dockerfile: "Dockerfile",
            ports: ["3000:3000"],
            dependsOn: [],
            environment: {},
            volumes: [],
            exposed: true,
            domain: "my-web-app",
            domainType: "free",
          },
        ],
      },
    );

    // fqdn = my-web-app.apps.example.com → not *.opsh.io → the operator's own edge.
    expect(result.checks.some((c) => (c.code ?? "").startsWith("CLOUD_REQUIRED"))).toBe(false);
    const runtime = result.checks.find((c) => c.id === "runtime");
    expect(runtime?.status).toBe("pass");
    // And no SaaS round-trip was made for a route we can serve ourselves.
    expect(preflightFn.mock.calls.length).toBe(0);
  });
});
