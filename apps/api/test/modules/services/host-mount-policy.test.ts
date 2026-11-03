import { repos, seedOwner, installFakeRunner } from "../jobs/_harness";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createShip } from "@repo/sdk/native";
import { OpenshipClient } from "@repo/sdk/client";
import { CloudDockerRuntime, DockerRuntime } from "@repo/adapters";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { assertDeployVolumePolicy } from "@repo/platform/engine/modules/deployments/host-mount-policy";
import { createServiceRuntimeConfig } from "@repo/platform/engine/modules/deployments/compose/deploy.service";
import { createServerDeployConfig } from "@repo/platform/engine/modules/deployments/build-pipeline";
import { env } from "@repo/platform/engine/config/env";
import { serviceRoutes } from "../../../src/modules/services/service.routes";
import { projectRoutes } from "../../../src/modules/projects/project.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { deploymentRoutes } from "../../../src/modules/deployments/deployment.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import { seedProject, seedService, seedDeployment } from "../../helpers/seed";

installFakeRunner();
const app = new Hono()
  .onError(handleApiError)
  .route("/api/health", healthRoutes)
  .route("/api/deployments", deploymentRoutes)
  .route("/api/projects/:id/services", serviceRoutes)
  .route("/api/projects", projectRoutes);

async function setup(instanceAdmin = false, bound = false) {
  const owner = await seedOwner({ instanceAdmin, bound });
  const project = await seedProject(owner.orgId, { framework: "docker-compose" });
  const service = await seedService(project.id, { name: "web", image: "alpine:3" });
  const user = (await repos.user.findById(owner.userId))!;
  const ship = createShip({
    platform: getPlatformKernel(),
    identity: {
      resolve: async () => ({
        user: { id: user.id, email: user.email, name: user.name },
        sessionId: "mount-policy-test",
      }),
    },
  });
  return {
    project,
    service,
    owner,
    clients: {
      native: await ship.scope({ identity: "verified", organizationId: owner.orgId }),
      http: new OpenshipClient({
        baseUrl: "http://openship.test",
        token: owner.token,
        organizationId: owner.orgId,
        fetch: ((url, init) => app.request(url as string, init)) as typeof fetch,
      }),
    },
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("authored mounts through HTTP and native operations", () => {
  it.each(["native", "http"] as const)(
    "%s rejects service and project writes before persistence",
    async (transport) => {
      const { project, service, clients } = await setup();
      const client = clients[transport];
      const volumes = ["/var/run/docker.sock:/socket"];
      const writes = [
        () => client.services.create(project.id, { name: "blocked", image: "alpine:3", volumes }),
        () => client.services.update(project.id, service.id, { volumes }),
        () =>
          client.services.sync(project.id, {
            services: [{ name: "blocked", image: "alpine:3", volumes }],
          }),
        () => client.projects.create({ name: "blocked", volumes }),
        () =>
          client.projects.ensure({
            name: "blocked",
            services: [{ name: "blocked", image: "alpine:3", volumes }],
          }),
        () => client.projects.ensure({ name: project.name, projectId: project.id, volumes }),
        () => client.projects.update(project.id, { volumes }),
        () => client.projects.setOptions(project.id, { volumes }),
        () =>
          client.deployments.buildAccess({
            projectId: project.id,
            services: [
              {
                name: "blocked",
                image: "alpine:3",
                volumes,
                ports: [],
                dependsOn: [],
                environment: {},
              },
            ],
          }),
      ];
      for (const [index, write] of writes.entries())
        await expect(write(), `write ${index}`).rejects.toMatchObject(
          transport === "native" ? { statusCode: 403 } : { status: 403 },
        );
      expect((await repos.service.listByProject(project.id)).map((row) => row.id)).toEqual([
        service.id,
      ]);
      expect((await repos.service.findById(service.id))?.volumes ?? []).toEqual([]);
      expect((await repos.project.findById(project.id))?.volumes ?? []).toEqual([]);
    },
  );

  it.each(["native", "http"] as const)("%s preserves named-volume writes", async (transport) => {
    const { project, service, clients } = await setup();
    const volumes = ["data:/data:ro", "/anonymous"];
    await clients[transport].services.update(project.id, service.id, { volumes });
    expect((await repos.service.findById(service.id))?.volumes).toEqual(volumes);
  });

  it("allows instance administrators to configure mounts but refuses bound admin credentials", async () => {
    const admin = await setup(true);
    const volumes = ["/srv/data:/data"];
    await admin.clients.http.services.update(admin.project.id, admin.service.id, { volumes });
    expect((await repos.service.findById(admin.service.id))?.volumes).toEqual(volumes);
    const bound = await setup(true, true);
    await expect(
      bound.clients.http.services.update(bound.project.id, bound.service.id, { volumes }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it.each(["native", "http"] as const)(
    "%s preserves Cloud repository mounts without granting host access",
    async (transport) => {
      const { project, service, clients } = await setup();
      const cloud = env.CLOUD_MODE;
      env.CLOUD_MODE = true;
      try {
        const volumes = ["./config:/etc/app:ro", "data:/data"];
        await clients[transport].services.update(project.id, service.id, { volumes });
        expect((await repos.service.findById(service.id))?.volumes).toEqual(volumes);
        await expect(
          clients[transport].services.update(project.id, service.id, {
            volumes: [...volumes, "/var/run/docker.sock:/socket"],
          }),
        ).rejects.toMatchObject(transport === "native" ? { statusCode: 403 } : { status: 403 });
        expect((await repos.service.findById(service.id))?.volumes).toEqual(volumes);
      } finally {
        env.CLOUD_MODE = cloud;
      }
    },
  );
});

describe("deployment boundary for repository, restored and previously stored mounts", () => {
  it("permits repository mounts only through the managed Cloud resolver", async () => {
    vi.stubEnv("OPENSHIP_ALLOW_HOST_BIND_MOUNTS", undefined);
    const runtime = Object.create(CloudDockerRuntime.prototype) as CloudDockerRuntime;
    const volumes = ["./config:/etc/app:ro"];
    const { project, service } = await setup();
    const dep = await seedDeployment(project);
    const input = {
      project,
      dep,
      service: { ...service, volumes },
      image: "alpine:3",
      environment: {},
    };
    expect(createServiceRuntimeConfig({ ...input, runtime }).volumes).toEqual(volumes);
    expect(() => createServiceRuntimeConfig(input)).toThrow("Host bind mounts are disabled");
    expect(() =>
      createServiceRuntimeConfig({
        ...input,
        runtime: Object.create(DockerRuntime.prototype) as DockerRuntime,
      }),
    ).toThrow("Host bind mounts are disabled");
    const phase = {
      project,
      dep,
      runtime,
      snapshot: { volumes },
      buildResult: {},
      deployRouting: { deployMode: "server" },
      routeState: {},
    } as unknown as Parameters<typeof createServerDeployConfig>[0];
    expect(createServerDeployConfig(phase).volumes).toEqual(volumes);
    vi.stubEnv("OPENSHIP_ALLOW_HOST_BIND_MOUNTS", "true");
    // A self-hosted control plane's opt-in must not authorize its Cloud target.
    phase.snapshot.volumes = ["/etc:/host"];
    expect(() => createServerDeployConfig(phase)).toThrow("Host bind mounts are disabled");
  });

  it.each([undefined, "false", "1", "TRUE"])(
    "denies authored host mounts with opt-in %s",
    (setting) => {
      vi.stubEnv("OPENSHIP_ALLOW_HOST_BIND_MOUNTS", setting);
      expect(() => assertDeployVolumePolicy(["data:/data", "/:/host"])).toThrow(
        "Host bind mounts are disabled",
      );
      expect(() => assertDeployVolumePolicy(["data:/data", "/anonymous", "storage"])).not.toThrow();
    },
  );

  it("requires an explicit operator opt-in and never permits it in Cloud", () => {
    vi.stubEnv("OPENSHIP_ALLOW_HOST_BIND_MOUNTS", "true");
    expect(() => assertDeployVolumePolicy(["/srv/data:/data"])).not.toThrow();
    const cloud = env.CLOUD_MODE;
    env.CLOUD_MODE = true;
    try {
      expect(() => assertDeployVolumePolicy(["/srv/data:/data"])).toThrow();
    } finally {
      env.CLOUD_MODE = cloud;
    }
  });

  it("rejects a stored service before producing a runtime configuration", async () => {
    vi.stubEnv("OPENSHIP_ALLOW_HOST_BIND_MOUNTS", undefined);
    const { project, service } = await setup();
    const dep = await seedDeployment(project);
    expect(() =>
      createServiceRuntimeConfig({
        project,
        dep,
        service: { ...service, volumes: ["/etc:/host"] },
        image: "alpine:3",
        environment: {},
      }),
    ).toThrow("Host bind mounts are disabled");
  });

  it("checks single-app snapshots before release commands or activation receive their config", async () => {
    vi.stubEnv("OPENSHIP_ALLOW_HOST_BIND_MOUNTS", undefined);
    const { project } = await setup();
    const dep = await seedDeployment(project);
    const phase = {
      project,
      dep,
      snapshot: { volumes: ["/etc:/host"] },
      buildResult: {},
      deployRouting: { deployMode: "server" },
      routeState: {},
    } as Parameters<typeof createServerDeployConfig>[0];
    expect(() => createServerDeployConfig(phase)).toThrow("Host bind mounts are disabled");
    phase.snapshot.volumes = ["data:/data"];
    expect(createServerDeployConfig(phase).volumes).toEqual(["data:/data"]);
  });
});
