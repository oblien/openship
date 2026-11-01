import { describe, expect, it, mock } from "bun:test";
import { repairCatalogImage } from "./catalog-image-repair";
import retiredBuilds from "./fixtures/catalog-retired-builds.json";

function client(
  image: string | null = "minio/minio:latest",
  activeDeploymentId: string | null = null,
) {
  const project = { id: "project", appTemplateId: "minio", activeDeploymentId };
  const service = {
    id: "service",
    projectId: "project",
    name: "minio",
    image,
    volumes: ["data:/data"],
    environment: { SECRET: "preserved" },
    advanced: null as Record<string, unknown> | null,
    build: null,
    buildArgs: null,
    command: null,
    commandArgv: null,
  };
  const update = mock(async () => service);
  const create = mock(async () => ({ deployment_id: "deployment" }));
  const wait = mock(async () => ({ deploymentId: "deployment", success: true, status: "ready" }));
  return {
    project,
    service,
    ship: {
      projects: { get: mock(async () => project) },
      services: { get: mock(async () => service), list: mock(async () => [service]), update },
      deployments: {
        create,
        list: mock(async () => ({ data: [{ projectId: "project", status: "failed" }] })),
      },
      deployment: () => ({ wait }),
    },
  };
}
const repair = (ship: ReturnType<typeof client>["ship"], apply = false) =>
  repairCatalogImage(
    ship as unknown as Parameters<typeof repairCatalogImage>[0],
    "project",
    "service",
    apply,
  );

describe("explicit retired catalog image repair", () => {
  it.each(["wordpress", "odoo"] as const)(
    "converts a reviewed %s recipe to its same official base, without touching database services or data",
    async (app) => {
      const c = client(null, "live");
      c.project.appTemplateId = app;
      c.service.name = app;
      c.service.advanced = {
        build: retiredBuilds[app],
        resources: { cpuCores: 2 },
        healthcheck: { test: ["CMD", "true"] },
      };
      const before = structuredClone(c.service);
      c.ship.services.list.mockResolvedValue([
        c.service,
        { ...c.service, id: "database", name: app + "-db" },
      ]);
      c.ship.deployments.list.mockResolvedValue({
        data: [{ projectId: "project", status: "ready" }],
      });
      expect(await repair(c.ship)).toMatchObject({
        status: "preview",
        from: "inline catalog build",
      });
      expect(c.ship.services.update).not.toHaveBeenCalled();
      const result = await repair(c.ship, true);
      expect(c.ship.services.update).toHaveBeenCalledWith("project", "service", {
        image: result.to,
        commandArgv: expect.any(Array),
        advanced: {
          build: null,
          files: expect.arrayContaining([
            expect.objectContaining({ path: expect.stringMatching(/^\/etc\/openship\//) }),
          ]),
        },
      });
      expect(c.ship.deployments.create).toHaveBeenCalledWith({
        projectId: "project",
        serviceIds: ["service"],
        forceAll: true,
      });
      expect(c.service).toEqual(before);
    },
  );

  it("preserves a customized recipe or mounted files instead of converting it", async () => {
    for (const custom of [
      {
        build: {
          ...retiredBuilds.wordpress,
          dockerfile: retiredBuilds.wordpress.dockerfile + "RUN echo custom\n",
        },
      },
      { build: retiredBuilds.wordpress, files: [{ path: "/etc/custom", content: "custom" }] },
    ]) {
      const c = client(null);
      c.project.appTemplateId = "wordpress";
      c.service.name = "wordpress";
      c.service.advanced = custom;
      await expect(repair(c.ship, true)).rejects.toThrow();
      expect(c.ship.services.update).not.toHaveBeenCalled();
    }
  });

  it("preserves custom startup commands and build arguments", async () => {
    for (const override of [
      { command: "custom-start" },
      { commandArgv: ["custom-start"] },
      { build: { context: "custom" } },
      { buildArgs: { CUSTOM: "value" } },
      { startCommand: "custom-start" },
      { dockerfile: "custom.Dockerfile" },
    ]) {
      const c = client(null);
      c.project.appTemplateId = "wordpress";
      c.service.name = "wordpress";
      c.service.advanced = { build: retiredBuilds.wordpress };
      Object.assign(c.service, override);
      await expect(repair(c.ship, true)).rejects.toThrow("custom settings");
      expect(c.ship.services.update).not.toHaveBeenCalled();
    }
  });

  it("does not convert a recipe while its deployment is still running", async () => {
    const c = client(null, "live");
    c.project.appTemplateId = "wordpress";
    c.service.name = "wordpress";
    c.service.advanced = { build: retiredBuilds.wordpress };
    c.ship.deployments.list.mockResolvedValue({
      data: [{ projectId: "project", status: "building" }],
    });
    await expect(repair(c.ship, true)).rejects.toThrow("Finish the current deployment");
    expect(c.ship.services.update).not.toHaveBeenCalled();
  });

  it("refuses a retired recipe changed after preview", async () => {
    const c = client(null);
    c.project.appTemplateId = "wordpress";
    c.service.name = "wordpress";
    c.service.advanced = { build: retiredBuilds.wordpress };
    c.ship.services.get.mockImplementationOnce(async () => ({ ...c.service }));
    c.ship.services.get.mockImplementationOnce(async () => ({
      ...c.service,
      advanced: { build: { dockerfile: "FROM custom:v1" } },
    }));
    await expect(repair(c.ship, true)).rejects.toThrow("changed during");
    expect(c.ship.services.update).not.toHaveBeenCalled();
  });

  it("previews without modifying anything", async () => {
    const { ship } = client();
    expect(await repair(ship)).toMatchObject({ status: "preview", from: "minio/minio:latest" });
    expect(ship.services.update).not.toHaveBeenCalled();
    expect(ship.deployments.create).not.toHaveBeenCalled();
  });
  it("changes only the failed service's image and uses a scoped normal deployment", async () => {
    const { ship, service } = client();
    const before = structuredClone(service);
    const result = await repair(ship, true);
    expect(ship.services.update).toHaveBeenCalledWith("project", "service", { image: result.to });
    expect(ship.deployments.create).toHaveBeenCalledWith({
      projectId: "project",
      serviceIds: ["service"],
      forceAll: true,
    });
    expect(service).toEqual(before);
    expect(result).toMatchObject({ status: "ready", success: true });
  });
  it("preserves custom images and running stateful installations", async () => {
    for (const c of [client("my/minio:v2"), client("minio/minio:latest", "live")]) {
      await expect(repair(c.ship, true)).rejects.toThrow();
      expect(c.ship.services.update).not.toHaveBeenCalled();
      expect(c.ship.deployments.create).not.toHaveBeenCalled();
    }
  });
  it("refuses a service changed after preview", async () => {
    const { ship } = client();
    ship.services.get.mockImplementationOnce(async () => ({ ...client().service }));
    ship.services.get.mockImplementationOnce(async () => ({
      ...client().service,
      image: "custom:v1",
    }));
    await expect(repair(ship, true)).rejects.toThrow("changed during");
    expect(ship.services.update).not.toHaveBeenCalled();
  });
  it("does not deploy sibling services in a partially installed app", async () => {
    const { ship, service } = client();
    ship.services.list.mockResolvedValue([service, { ...service, id: "sibling" }]);
    await expect(repair(ship, true)).rejects.toThrow("single-service");
    expect(ship.services.update).not.toHaveBeenCalled();
  });
  it("refuses drafts and deployments that are still running", async () => {
    for (const data of [[], [{ projectId: "project", status: "building" }]]) {
      const { ship } = client();
      ship.deployments.list.mockResolvedValue({ data });
      await expect(repair(ship, true)).rejects.toThrow("must have failed");
      expect(ship.services.update).not.toHaveBeenCalled();
      expect(ship.deployments.create).not.toHaveBeenCalled();
    }
  });
});
