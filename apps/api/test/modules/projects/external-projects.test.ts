import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, repos, schema } from "@repo/db";
import type { ExecutionContext } from "@repo/platform";
import {
  seedDeployment,
  seedOrg,
  seedProject,
  seedService,
  seedServiceDeployment,
  setActive,
} from "../../helpers/seed";

const h = vi.hoisted(() => ({
  containers: [] as Array<{
    id: string;
    names: string[];
    image: string;
    state: string;
    status: string;
    labels: Record<string, string>;
    composeProject?: string;
    composeService?: string;
  }>,
  runtimeServers: [] as Array<string | undefined>,
  logTargets: [] as string[],
  disposed: 0,
  refreshConnectionEnv: vi.fn(),
  cloud: false,
}));

vi.mock("@repo/platform/engine/config/env", async (original) => {
  const actual = await original<{ env: Record<string, unknown> }>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get CLOUD_MODE() {
        return h.cloud;
      },
    },
  };
});

vi.mock("@repo/platform/engine/modules/projects/project-connection.service", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  refreshConnectionEnv: h.refreshConnectionEnv,
}));

vi.mock("@repo/platform/engine/lib/deployment-runtime", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createServerDockerRuntime: async (serverId: string | undefined) => {
    h.runtimeServers.push(serverId);
    return {
      listAllContainers: async () => h.containers,
      getRuntimeLogs: async (id: string) => {
        h.logTargets.push(id);
        return [{ timestamp: "t", message: `from ${id}`, level: "info" }];
      },
      streamRuntimeLogs: async (id: string) => {
        h.logTargets.push(id);
        return () => {};
      },
    };
  },
  disposeRuntime: () => {
    h.disposed += 1;
  },
}));

const { createExternalProject, listExternalContainers } =
  await import("@repo/platform/engine/modules/projects/external-project.service");
const { getRuntimeLogs, streamRuntimeLogs } =
  await import("@repo/platform/engine/modules/projects/project-runtime.service");
const { createQueuedDeployment } =
  await import("@repo/platform/engine/modules/deployments/build.service");
const { createService } = await import("@repo/platform/engine/modules/services/service.service");
const { triggerDeployment } =
  await import("@repo/platform/engine/modules/deployments/build.service");
const { projectRoutingOperations } =
  await import("@repo/platform/engine/modules/projects/project-routing.operations");
const crud = await import("@repo/platform/engine/modules/projects/project-crud.service");
const { addDomain } = await import("@repo/platform/engine/modules/domains/domain.service");
const { projectDependencies } =
  await import("@repo/platform/engine/modules/projects/project.operations");

const builds = await import("@repo/platform/engine/modules/deployments/build.service");
const domains = await import("@repo/platform/engine/modules/domains/domain.service");
const services = await import("@repo/platform/engine/modules/services/service.service");
const { previewRestore } =
  await import("@repo/platform/engine/modules/deployments/deployment.service");

const container = (id: string, name: string, state: string, labels: Record<string, string>) => ({
  id,
  names: [name],
  image: "registry/app:1",
  state,
  status: state,
  labels,
});
const kamal = { service: "shop", role: "web" };

let ctx: ExecutionContext;
let serverId: string;

beforeEach(async () => {
  h.containers = [];
  h.runtimeServers = [];
  h.logTargets = [];
  h.disposed = 0;
  h.cloud = false;
  ctx = (await seedOrg()) as ExecutionContext;
  serverId = (
    await repos.server.create({ organizationId: ctx.organizationId, sshHost: "192.0.2.30" })
  ).id;
}, 30_000);

const createShop = () =>
  createExternalProject(
    {
      name: `shop-${Math.random().toString(36).slice(2, 8)}`,
      serverId,
      matchers: [{ labels: kamal }],
    },
    ctx.organizationId,
  );

describe("creating an external project", () => {
  it("stores the server and matchers on an observe-only project row", async () => {
    const project = await createShop();
    const row = await repos.project.findById(project.id);

    expect(row).toMatchObject({
      gitProvider: "external",
      serverId,
      autoDeploy: false,
      runtimeMode: "docker",
    });
    expect(row?.externalConfig).toEqual({ serverId, matchers: [{ labels: kamal }] });
  });

  it("rejects a server from another organization", async () => {
    const other = await seedOrg();
    const foreign = await repos.server.create({
      organizationId: other.organizationId,
      sshHost: "192.0.2.31",
    });

    await expect(
      createExternalProject(
        { name: "x", serverId: foreign.id, matchers: [{ name: "web" }] },
        ctx.organizationId,
      ),
    ).rejects.toThrow(/not found/i);
  });

  it("rejects matchers that pin neither a name nor a label", async () => {
    await expect(
      createExternalProject(
        { name: "x", serverId, matchers: [{ labels: {} }] },
        ctx.organizationId,
      ),
    ).rejects.toThrow(/container name or at least one label/);
  });

  it("refuses Cloud mode, managed servers, and migration-only connections", async () => {
    const create = (id: string) =>
      createExternalProject(
        { name: "x", serverId: id, matchers: [{ name: "web" }] },
        ctx.organizationId,
      );
    const workspace = await repos.cloudWorkspace.create({
      organizationId: ctx.organizationId,
      name: "Prod",
    });
    const managed = (await repos.server.findByWorkspace(workspace.id, ctx.organizationId))!;
    const source = await repos.server.create({
      organizationId: ctx.organizationId,
      sshHost: "192.0.2.32",
      purpose: "migration_source",
      sshAuthMethod: "password",
      sshPassword: "x",
      sshHostKey: "AAAA",
    });

    await expect(create(managed.id)).rejects.toThrow(/Managed Cloud servers/);
    await expect(create(source.id)).rejects.toMatchObject({ code: "MIGRATION_SOURCE_ONLY" });
    h.cloud = true;
    await expect(create(serverId)).rejects.toMatchObject({ code: "EXTERNAL_PROJECT_UNSUPPORTED" });
  });
});

describe("reading an external project", () => {
  it("lists matched containers, never Openship's own, with only the matched labels", async () => {
    const project = await createShop();
    const ownStack = (id: string, service: string) => ({
      ...container(id, `openship-${service}-1`, "running", kamal),
      composeProject: "openship",
      composeService: service,
    });
    h.containers = [
      container("c-web", "shop-web-1", "running", { ...kamal, "secret.token": "s3cr3t" }),
      container("c-other", "blog-web-1", "running", { service: "blog", role: "web" }),
      container("c-edge", "openship-edge", "running", kamal),
      container("c-managed", "shop-managed", "running", { ...kamal, "openship.project": "p" }),
      ownStack("c-api", "api"),
      ownStack("c-dash", "dashboard"),
    ];

    const listed = await listExternalContainers(project.id, ctx.organizationId);

    expect(listed.map((c) => c.id)).toEqual(["c-web"]);
    expect(listed[0]?.labels).toEqual(kamal);
    expect(h.runtimeServers).toEqual([serverId]);
    expect(h.disposed).toBe(1);
  });

  it("hides a matched container that an Openship service deployment owns", async () => {
    const project = await createShop();
    const owner = await seedProject(ctx.organizationId);
    const service = await seedService(owner.id, { name: "web" });
    await seedServiceDeployment((await seedDeployment(owner)).id, service, {
      containerId: "c-owned",
    });
    h.containers = [
      container("c-web", "shop-web-1", "running", kamal),
      container("c-owned", "shop-web-2", "running", kamal),
    ];

    const listed = await listExternalContainers(project.id, ctx.organizationId);

    expect(listed.map((c) => c.id)).toEqual(["c-web"]);
  });

  it("reads logs from the running matched container, preferring it over a stopped one", async () => {
    const project = await createShop();
    h.containers = [
      container("c-old", "shop-web-0", "exited", kamal),
      container("c-live", "shop-web-1", "running", kamal),
      container("c-other", "blog-web-1", "running", { service: "blog" }),
    ];

    const logs = await getRuntimeLogs(project.id, ctx.organizationId);
    const stream = await streamRuntimeLogs(project.id, ctx.organizationId, () => {});
    stream.cleanup();

    expect(logs[0]?.message).toBe("from c-live");
    expect(h.logTargets).toEqual(["c-live", "c-live"]);
    expect(h.disposed).toBe(2);
  });

  it("answers 404 when no container matches, and closes the runtime", async () => {
    const project = await createShop();
    h.containers = [container("c-other", "blog-web-1", "running", { service: "blog" })];

    await expect(getRuntimeLogs(project.id, ctx.organizationId)).rejects.toThrow(
      /No matching container/,
    );
    expect(h.disposed).toBe(1);
  });
});

describe("external projects refuse every mutation", () => {
  it("refuses a queued deployment and a new service", async () => {
    const project = await createShop();

    await expect(
      createQueuedDeployment({
        projectId: project.id,
        organizationId: ctx.organizationId,
        branch: "main",
        environment: "production",
        framework: "unknown",
        meta: {} as never,
        envVars: {},
      }),
    ).rejects.toThrow(/deployed by another tool/);
    await expect(
      createService(ctx, project.id, { name: "db", image: "postgres:16" } as never),
    ).rejects.toThrow(/deployed by another tool/);
    expect(await repos.deployment.listInFlightByProject(project.id)).toEqual([]);
  });

  it("refuses deploy entry points before they write anything", async () => {
    const project = await createShop();

    await expect(triggerDeployment(ctx, { projectId: project.id })).rejects.toThrow(
      /deployed by another tool/,
    );
    expect(await repos.deployment.listInFlightByProject(project.id)).toEqual([]);
    expect(await repos.domain.listByProject(project.id)).toEqual([]);
  });

  it("refuses source, route, domain, and environment changes", async () => {
    const project = await createShop();
    const refused = /deployed by another tool/;

    await expect(crud.ensureProject({ name: project.name }, ctx.organizationId)).rejects.toThrow(
      refused,
    );
    await expect(
      crud.linkProjectRepo(ctx, project.id, { owner: "acme", repo: "shop" }),
    ).rejects.toThrow(refused);
    await expect(
      crud.setProjectReleaseImageSource(project.id, ctx.organizationId, {
        artifactKind: "image",
        mode: "github",
        repo: "acme/shop",
        imageTemplate: "ghcr.io/acme/shop:{tag}",
      } as never),
    ).rejects.toThrow(refused);
    await expect(
      crud.updateProject(project.id, { publicEndpoints: [] }, ctx.organizationId),
    ).rejects.toThrow(refused);
    await expect(
      crud.updateProject(project.id, { port: 8080 }, ctx.organizationId),
    ).rejects.toThrow(refused);
    await expect(
      addDomain(ctx, { projectId: project.id, hostname: "shop.example.com" } as never),
    ).rejects.toThrow(refused);
    await expect(
      crud.createProjectEnvironment(project.id, ctx, { environmentName: "Preview" } as never),
    ).rejects.toThrow(refused);
    await expect(
      projectRoutingOperations.removeRouteRule(ctx, project.id, "rule-1"),
    ).rejects.toThrow(refused);
    expect(await repos.project.findById(project.id)).toMatchObject({ gitProvider: "external" });
  });

  it("keeps the external provider off the generic create and update bodies", async () => {
    const project = await createShop();

    await expect(
      projectDependencies.create(ctx, { name: "sneaky", gitProvider: "external" }),
    ).rejects.toThrow(/POST \/api\/projects\/external/);
    await expect(
      projectDependencies.update(ctx, project.id, { gitProvider: "external" }),
    ).rejects.toThrow(/POST \/api\/projects\/external/);
  });

  describe("with rows a project could have acquired", () => {
    const seedRows = async () => {
      const project = await createShop();
      const deployment = await seedDeployment(project as never);
      const [domain] = await db
        .insert(schema.domain)
        .values({
          id: `dom-${project.id}`,
          hostname: `${project.id}.example.com`,
          projectId: project.id,
          verificationToken: "t",
          domainType: "custom",
          createdAt: new Date(0),
        })
        .returning();
      const [service] = await db
        .insert(schema.service)
        .values({ id: `svc-${project.id}`, projectId: project.id, name: "web", image: "shop:1" })
        .returning();
      return { project, deployment: deployment.id, domain: domain!.id, service: service!.id };
    };

    it.each([
      [
        "requestBuildAccess",
        (x: Rows) => builds.requestBuildAccess(ctx, { projectId: x.project.id } as never),
      ],
      ["previewRestore", (x: Rows) => previewRestore(x.deployment, ctx.organizationId)],
      ["verifyDomain", (x: Rows) => domains.verifyDomain(ctx, x.domain)],
      ["setPrimaryDomain", (x: Rows) => domains.setPrimaryDomain(ctx, x.domain)],
      [
        "startServiceContainer",
        (x: Rows) => services.startServiceContainer(ctx, x.project.id, x.service),
      ],
      [
        "stopServiceContainer",
        (x: Rows) => services.stopServiceContainer(ctx, x.project.id, x.service),
      ],
      [
        "syncComposeServices",
        (x: Rows) =>
          services.syncComposeServices(ctx, x.project.id, [
            { name: "db", image: "postgres:16" },
          ] as never),
      ],
    ])("refuses %s", async (_name, run) => {
      await expect(run(await seedRows())).rejects.toThrow(/deployed by another tool/);
    });

    it("refuses a redeploy before it refreshes the project's environment", async () => {
      const { deployment } = await seedRows();
      h.refreshConnectionEnv.mockClear();

      await expect(builds.redeployBuildSession(ctx, deployment)).rejects.toThrow(
        /deployed by another tool/,
      );
      expect(h.refreshConnectionEnv).not.toHaveBeenCalled();
    });

    it("leaves external domains out of the pending verification sweep", async () => {
      const { project, deployment, domain } = await seedRows();
      await setActive(project.id, deployment);

      const result = await domains.verifyPendingDomains({ organizationId: ctx.organizationId });

      expect(result.total).toBe(0);
      expect((await repos.domain.findById(domain))?.lastCheckedAt ?? null).toBeNull();
    });
  });
});

type Rows = { project: { id: string }; deployment: string; domain: string; service: string };
