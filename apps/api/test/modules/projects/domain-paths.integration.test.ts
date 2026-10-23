import { beforeEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { repos, seedOwner } from "../jobs/_harness";
import { updateProject } from "@repo/platform/engine/modules/projects/project-crud.service";
import { withProjectRuntimeLock } from "@repo/platform/engine/lib/project-runtime-lock";
import { buildDomainFanoutRegistrations } from "@repo/platform/engine/modules/deployments/compose/composite-route";
import { OpenshipClient } from "@repo/sdk/client";
import { createShip } from "@repo/sdk/native";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { projectRoutes } from "../../../src/modules/projects/project.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { handleApiError } from "../../../src/middleware/error-handler";

const h = vi.hoisted(() => ({ order: [] as string[] }));
vi.mock("@repo/platform/engine/lib/platform-config", () => ({
  platform: () => ({ target: "local", runtime: { name: "docker" } }),
}));
vi.mock("@repo/platform/engine/modules/domains/project-route.service", async (original) => ({
  ...(await original<object>()),
  reapplyProjectLiveRoutes: async () => {
    h.order.push("base");
  },
}));
vi.mock("@repo/platform/engine/modules/domains/routing-apply.service", async (original) => ({
  ...(await original<object>()),
  applyProjectRouting: async () => {
    h.order.push("paths");
  },
}));
beforeEach(() => {
  h.order = [];
});

async function seed(orgId?: string) {
  const owner = await seedOwner();
  const organizationId = orgId ?? owner.orgId;
  const group = await repos.projectGroup.create({
    organizationId,
    name: "Paths",
    slug: owner.userId,
  });
  const project = await repos.project.create({
    organizationId,
    groupId: group.id,
    name: "Paths",
    slug: owner.userId,
    runtimeMode: "docker",
  });
  const frontend = await repos.service.create({
    projectId: project.id,
    name: "web",
    image: "nginx:alpine",
    enabled: true,
    exposed: true,
    exposedPort: "8080",
    ports: ["8080"],
    domainType: "custom",
    customDomain: `${owner.userId}.example.com`,
  });
  const backend = await repos.service.create({
    projectId: project.id,
    name: "api",
    image: "node:22",
    enabled: true,
    exposed: false,
    exposedPort: "9000",
    ports: ["9000"],
  });
  const domain = await repos.domain.create({
    projectId: project.id,
    serviceId: frontend.id,
    hostname: frontend.customDomain!,
    domainType: "custom",
    targetPort: 8080,
    verified: true,
  });
  return { owner, organizationId, project, frontend, backend, domain };
}

it("persists paths through SDK/HTTP and native operations without duplicating domains or endpoint arrays", async () => {
  for (const transport of ["http", "native"] as const) {
    const s = await seed();
    const app = new Hono()
      .onError(handleApiError)
      .route("/api/health", healthRoutes)
      .route("/api/projects", projectRoutes);
    const user = (await repos.user.findById(s.owner.userId))!;
    const ship = createShip({
      platform: getPlatformKernel(),
      identity: {
        resolve: async () => ({
          user: { id: user.id, email: user.email, name: user.name },
          sessionId: "domain-paths-test",
        }),
      },
    });
    const client =
      transport === "http"
        ? new OpenshipClient({
            baseUrl: "http://openship.test",
            token: s.owner.token,
            organizationId: s.organizationId,
            fetch: ((url, init) => app.request(url as string, init)) as typeof fetch,
          })
        : await ship.scope({ identity: "verified", organizationId: s.organizationId });
    const before = await repos.service.findById(s.frontend.id);
    await client.projects.update(s.project.id, {
      domainRoutes: [
        {
          domainId: s.domain.id,
          paths: [{ pathPrefix: "/api", serviceId: s.backend.id, port: 9000 }],
        },
      ],
    });
    const current = (await repos.project.findById(s.project.id))!;
    expect(current.compositeRoutes).toEqual([
      {
        hostname: s.domain.hostname,
        isCustomDomain: true,
        rootServiceId: s.frontend.id,
        rootPort: 8080,
        locations: [{ pathPrefix: "/api", serviceId: s.backend.id, port: 9000 }],
      },
    ]);
    expect(await repos.domain.listByProject(s.project.id)).toHaveLength(1);
    expect(await repos.service.findById(s.frontend.id)).toEqual(before);
    expect(
      buildDomainFanoutRegistrations({
        routes: current.compositeRoutes,
        services: [s.frontend, s.backend],
        domainByHostname: new Map([[s.domain.hostname, s.domain]]),
        resolveTargetUrl: (id, port) =>
          `http://${id === s.frontend.id ? "10.0.0.2" : "10.0.0.3"}:${port}`,
      }),
    ).toMatchObject([
      {
        hostname: s.domain.hostname,
        targetUrl: "http://10.0.0.2:8080",
        proxyLocations: [{ pathPrefix: "/api", targetUrl: "http://10.0.0.3:9000" }],
      },
    ]);
    expect(h.order.slice(-2)).toEqual(["base", "paths"]);
    await client.projects.update(s.project.id, {
      domainRoutes: [{ domainId: s.domain.id, paths: [] }],
    });
    expect((await repos.project.findById(s.project.id))?.compositeRoutes).toBeNull();
    expect(h.order.slice(-2)).toEqual(["base", "paths"]);
    expect(await repos.domain.findById(s.domain.id)).toMatchObject({
      serviceId: s.frontend.id,
      targetPort: 8080,
    });
  }
});

it("rejects foreign domains, services, undeclared ports and unsafe paths before accompanying edits", async () => {
  const s = await seed(),
    foreign = await seed(s.organizationId);
  const paths = [{ pathPrefix: "/api", serviceId: s.backend.id, port: 9000 }];
  const requests = [
    [{ domainId: foreign.domain.id, paths }],
    [
      { domainId: s.domain.id, paths },
      { domainId: foreign.domain.id, paths },
    ],
    [{ domainId: s.domain.id, paths: [{ ...paths[0], serviceId: foreign.backend.id }] }],
    [{ domainId: s.domain.id, paths: [{ ...paths[0], port: 8081 }] }],
    [{ domainId: s.domain.id, paths: [paths[0], paths[0]] }],
    ...["/", "/api;return", "/a/../secret", "/%2fapi", "/api/{bad}", "/api?x=1"].map(
      (pathPrefix) => [{ domainId: s.domain.id, paths: [{ ...paths[0], pathPrefix }] }],
    ),
  ];
  for (const domainRoutes of requests) {
    await expect(
      updateProject(
        s.project.id,
        { name: "Must not persist", domainRoutes } as never,
        s.organizationId,
      ),
    ).rejects.toThrow();
    expect(await repos.project.findById(s.project.id)).toMatchObject({
      name: "Paths",
      compositeRoutes: null,
    });
  }
  await expect(
    updateProject(s.project.id, { domainRoutes: [] }, foreign.owner.orgId),
  ).rejects.toThrow();
  await repos.service.update(s.frontend.id, { exposed: false });
  await expect(
    updateProject(
      s.project.id,
      { domainRoutes: [{ domainId: s.domain.id, paths }] },
      s.organizationId,
    ),
  ).rejects.toThrow("Expose this domain's root service");
  expect(h.order).toEqual([]);
});

it("patches only the selected domain, retains other tables and revalidates after waiting for the project lock", async () => {
  const s = await seed();
  const sibling = await repos.domain.create({
    projectId: s.project.id,
    serviceId: s.frontend.id,
    hostname: `second-${s.domain.hostname}`,
    domainType: "custom",
    targetPort: 8080,
  });
  const paths = [{ pathPrefix: "/api", serviceId: s.backend.id }];
  await updateProject(
    s.project.id,
    {
      domainRoutes: [
        { domainId: s.domain.id, paths },
        { domainId: sibling.id, paths },
      ],
    },
    s.organizationId,
  );
  await updateProject(
    s.project.id,
    { domainRoutes: [{ domainId: sibling.id, paths: [] }] },
    s.organizationId,
  );
  expect(
    (await repos.project.findById(s.project.id))?.compositeRoutes?.map((route) => route.hostname),
  ).toEqual([s.domain.hostname]);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = withProjectRuntimeLock(s.project.id, async () => {
    enter();
    await held;
  });
  await entered;
  const edit = updateProject(
    s.project.id,
    { domainRoutes: [{ domainId: s.domain.id, paths }] },
    s.organizationId,
  );
  const result = expect(edit).rejects.toThrow("enabled container service");
  await repos.service.update(s.backend.id, { enabled: false });
  release();
  await holder;
  await result;
});
