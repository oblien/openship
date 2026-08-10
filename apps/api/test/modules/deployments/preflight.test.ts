import { beforeEach, describe, expect, it, vi } from "vitest";

const { cloudClient, runCloudPreflight, preflightFn } = vi.hoisted(() => ({
  cloudClient: vi.fn(),
  runCloudPreflight: vi.fn(),
  preflightFn: vi.fn(),
}));

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: {},
  };
});

vi.mock("../../../src/lib/controller-helpers", () => ({
  platform: () => ({ target: "desktop" }),
}));

vi.mock("../../../src/lib/cloud/client", () => ({
  cloudClient,
}));

vi.mock("../../../src/lib/cloud/session", () => ({
  // De-conflation reads this when a cloud preflight comes back null; stub
  // it so the mock surface is complete even on that branch.
  isCloudConnectedForOrg: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../../src/lib/cloud-preflight", () => ({
  runCloudPreflight,
}));

// Keep the custom-domain DNS branch (checkCustomDomainSelfHosted) off the network
// and deterministic — a custom host resolves to "no records yet" (a warn on the
// `domain` check), never a cloud requirement. Isolates the cloud-gating assertions.
vi.mock("../../../src/lib/dns-resolver", () => ({
  resolveRecords: vi.fn().mockResolvedValue([]),
  lookupAddresses: vi.fn().mockResolvedValue([]),
}));

import { runPreflightChecks } from "../../../src/modules/deployments/preflight";

describe("runPreflightChecks", () => {
  beforeEach(() => {
    runCloudPreflight.mockReset();
    cloudClient.mockReset();
    preflightFn.mockReset();
    preflightFn.mockImplementation(async (input: { slug?: string }) => ({
      runtime: { ok: true },
      slug: input.slug
        ? {
            available: input.slug !== "taken-endpoint",
            message: input.slug === "taken-endpoint"
              ? "\"taken-endpoint.openship.test\" is already taken. Choose a different subdomain."
              : undefined,
          }
        : undefined,
    }));
    cloudClient.mockReturnValue({ preflight: preflightFn } as any);
    runCloudPreflight.mockImplementation(async (_userId: string, input: { slug?: string }) =>
      preflightFn(input),
    );
  });

  it("checks free-domain availability for every public endpoint", async () => {
    const result = await runPreflightChecks({
      repoUrl: "https://github.com/acme/app.git",
      branch: "main",
      buildImage: "node:22",
      installCommand: "npm install",
      buildCommand: "npm run build",
      startCommand: "npm start",
      port: 3000,
      hasBuild: true,
      hasServer: true,
      deployTarget: "server",
      organizationId: "org-1",
    } as any, {
      ctx: { userId: "user-1", organizationId: "org-1" } as any,
      buildStrategy: "local",
      publicEndpoints: [
        { port: 3000, domain: "taken-endpoint", domainType: "free" },
        { port: 4000, domain: "ok-endpoint", domainType: "free" },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        // ids are keyed by endpoint index now (collision-safe): endpoint 0
        // = taken-endpoint (port 3000), endpoint 1 = ok-endpoint (port 4000).
        expect.objectContaining({
          id: "endpoint-0-availability",
          status: "fail",
        }),
        expect.objectContaining({
          id: "endpoint-1-availability",
          status: "pass",
        }),
      ]),
    );
    expect(
      preflightFn.mock.calls.some(([input]) => input && input.slug === "taken-endpoint"),
    ).toBe(true);
    expect(
      preflightFn.mock.calls.some(([input]) => input && input.slug === "ok-endpoint"),
    ).toBe(true);
  });

  it("accepts static path-targeted public endpoints", async () => {
    const result = await runPreflightChecks({
      repoUrl: "https://github.com/acme/docs.git",
      branch: "main",
      buildImage: "node:22",
      installCommand: "npm install",
      buildCommand: "npm run build",
      startCommand: "",
      port: 3000,
      hasBuild: true,
      hasServer: false,
      deployTarget: "cloud",
      organizationId: "org-1",
    } as any, {
      ctx: { userId: "user-1", organizationId: "org-1" } as any,
      buildStrategy: "local",
      publicEndpoints: [
        { targetPath: "/docs", domain: "docs-site", domainType: "free" },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.checks.some((check) => check.status === "fail")).toBe(false);
  });

  it("does not require framework build fields for compose service deploys", async () => {
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
            exposed: false,
          },
        ],
      },
    );

    expect(result.ok).toBe(true);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "config",
          label: "Service configuration",
          status: "pass",
        }),
      ]),
    );
    expect(result.checks.some((check) => check.message?.includes("build image"))).toBe(false);
    expect(result.checks.some((check) => check.message?.includes("install command"))).toBe(false);
    expect(result.checks.some((check) => check.message?.includes("start command"))).toBe(false);
  });

  it("warns instead of failing on a monorepo sub-app that has never been deployed and has no commands", async () => {
    const result = await runPreflightChecks(
      {
        repoUrl: "https://github.com/acme/monorepo.git",
        branch: "main",
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
            kind: "monorepo",
            name: "orphaned-app",
            rootDirectory: ".",
            enabled: true,
            everDeployed: false,
          },
        ],
      },
    );

    // "warn" is not "fail" — the deploy proceeds.
    expect(result.ok).toBe(true);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "config",
          label: "Service configuration",
          status: "warn",
        }),
      ]),
    );
    expect(
      result.checks.find((c) => c.id === "config")?.message,
    ).toContain("orphaned-app");
  });

  it("still hard-fails a monorepo sub-app missing commands when it HAS been deployed before", async () => {
    const result = await runPreflightChecks(
      {
        repoUrl: "https://github.com/acme/monorepo.git",
        branch: "main",
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
            kind: "monorepo",
            name: "live-app",
            rootDirectory: ".",
            enabled: true,
            everDeployed: true,
          },
        ],
      },
    );

    expect(result.ok).toBe(false);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "config",
          label: "Service configuration",
          status: "fail",
        }),
      ]),
    );
  });

  it("does NOT flag a never-deployed docker sub-app as a dead row (its Dockerfile owns the build, so empty commands are correct)", async () => {
    const result = await runPreflightChecks(
      {
        repoUrl: "https://github.com/acme/monorepo.git",
        branch: "main",
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
            kind: "monorepo",
            name: "api",
            framework: "docker",
            rootDirectory: "apps/api",
            enabled: true,
            everDeployed: false,
          },
        ],
      },
    );

    // A Dockerfile sub-app is legitimately command-less → pass, not a "dead row"
    // warning and not a hard fail.
    expect(result.ok).toBe(true);
    const config = result.checks.find((c) => c.id === "config");
    expect(config?.status).toBe("pass");
    expect(config?.message ?? "").not.toContain("api");
  });

  // #427 follow-up — cloud isolation on self-hosted.
  //
  // The old preflight used the coarse `domainType !== "custom"` predicate
  // (endpointsNeedCloud / servicesNeedCloud), so ANY endpoint not explicitly
  // tagged "custom" — including a stale/mislabeled row whose hostname is plainly
  // NOT a cloud (*.opsh.io) host — forced a cloud requirement and 403'd the
  // deploy on the operator's own server, even though create/update had already
  // let it through. Preflight now classifies by HOSTNAME truth
  // (storedPublicEndpointsNeedCloud), exactly like the write gates, so a
  // custom / own-HOST_DOMAIN / null-domainType route stays on the operator's
  // edge and never touches cloud.
  describe("cloud isolation on self-hosted (#427 follow-up)", () => {
    it("does NOT require cloud for a custom-hostname endpoint mislabeled domainType:'free'", async () => {
      const result = await runPreflightChecks(
        {
          repoUrl: "https://github.com/acme/app.git",
          branch: "main",
          buildImage: "node:22",
          installCommand: "npm install",
          buildCommand: "npm run build",
          startCommand: "npm start",
          port: 3000,
          hasBuild: true,
          hasServer: true,
          deployTarget: "server",
          organizationId: "org-1",
        } as any,
        {
          ctx: { userId: "user-1", organizationId: "org-1" } as any,
          buildStrategy: "local",
          // A real custom host, but domainType is stale/wrong. Coarse predicate
          // -> cloud-gated (the bug); hostname-aware -> not gated.
          publicEndpoints: [{ port: 3000, customDomain: "app.example.com", domainType: "free" }],
        },
      );

      const runtime = result.checks.find((c) => c.id === "runtime");
      expect(runtime?.status).toBe("pass");
      expect(result.checks.some((c) => (c.code ?? "").startsWith("CLOUD_REQUIRED"))).toBe(false);
      // No cloud contact at all for a self-hosted custom-domain deploy.
      expect(preflightFn.mock.calls.length).toBe(0);
    });

    it("does NOT require cloud for an endpoint with an absent domainType (stale row) on a non-cloud host", async () => {
      const result = await runPreflightChecks(
        {
          repoUrl: "https://github.com/acme/app.git",
          branch: "main",
          buildImage: "node:22",
          installCommand: "npm install",
          buildCommand: "npm run build",
          startCommand: "npm start",
          port: 3000,
          hasBuild: true,
          hasServer: true,
          deployTarget: "server",
          organizationId: "org-1",
        } as any,
        {
          ctx: { userId: "user-1", organizationId: "org-1" } as any,
          buildStrategy: "local",
          publicEndpoints: [{ port: 3000, customDomain: "app.example.com" }],
        },
      );

      const runtime = result.checks.find((c) => c.id === "runtime");
      expect(runtime?.status).toBe("pass");
      expect(result.checks.some((c) => (c.code ?? "").startsWith("CLOUD_REQUIRED"))).toBe(false);
      expect(preflightFn.mock.calls.length).toBe(0);
    });

    it("does NOT require cloud when an exposed compose service uses a custom host mislabeled 'free'", async () => {
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
              customDomain: "svc.example.com",
              domainType: "free",
            },
          ],
        },
      );

      const runtime = result.checks.find((c) => c.id === "runtime");
      expect(runtime?.status).toBe("pass");
      expect(result.checks.some((c) => (c.code ?? "").startsWith("CLOUD_REQUIRED"))).toBe(false);
      expect(preflightFn.mock.calls.length).toBe(0);
    });

    it("STILL requires cloud (with a real error) for a genuine free *.opsh.io service subdomain when not connected", async () => {
      // The opposite guard: a real free subdomain routes under the actual Cloud
      // domain, so a NOT-connected deploy must fail with a real CLOUD_REQUIRED
      // code — not silently pass. Proves the isolation fixes narrowed the gate,
      // they didn't remove it.
      preflightFn.mockResolvedValue(null); // SaaS bridge returns no data == not connected

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

      expect(result.ok).toBe(false);
      expect(
        result.checks.some(
          (c) => c.code === "CLOUD_REQUIRED_MANAGED_COMPOSE_DOMAINS",
        ),
      ).toBe(true);
    });
  });
});
