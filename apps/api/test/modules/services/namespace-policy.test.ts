import { repos, seedOwner, installFakeRunner } from "../jobs/_harness";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createShip } from "@repo/sdk/native";
import { OpenshipClient } from "@repo/sdk/client";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { serviceRoutes } from "../../../src/modules/services/service.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import { seedProject, seedService } from "../../helpers/seed";

installFakeRunner();
const app = new Hono()
  .onError(handleApiError)
  .route("/api/health", healthRoutes)
  .route("/api/projects/:id/services", serviceRoutes);

async function setup() {
  const owner = await seedOwner();
  const project = await seedProject(owner.orgId, { framework: "docker-compose" });
  const service = await seedService(project.id, { name: "web", image: "alpine:3" });
  const user = (await repos.user.findById(owner.userId))!;
  const ship = createShip({
    platform: getPlatformKernel(),
    identity: {
      resolve: async () => ({
        user: { id: user.id, email: user.email, name: user.name },
        sessionId: "namespace-test",
      }),
    },
  });
  return {
    project,
    service,
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

describe("namespace settings through HTTP and native SDK writes", () => {
  it.each(["native", "http"] as const)(
    "%s refuses external namespace references before saving",
    async (transport) => {
      const { project, service, clients } = await setup();
      const client = clients[transport];
      for (const field of ["networkMode", "pidMode"] as const) {
        for (const value of ["container:openship-edge", "container:openship-api-1", "host"]) {
          const advanced = { [field]: value };
          for (const write of [
            () =>
              client.services.create(project.id, { name: "blocked", image: "alpine:3", advanced }),
            () => client.services.update(project.id, service.id, { advanced }),
            () =>
              client.services.sync(project.id, {
                services: [{ name: "blocked", image: "alpine:3", advanced }],
              }),
          ])
            await expect(write()).rejects.toMatchObject(
              transport === "native" ? { statusCode: 400 } : { status: 400 },
            );
        }
      }
      expect((await repos.service.listByProject(project.id)).map((row) => row.id)).toEqual([
        service.id,
      ]);
      expect((await repos.service.findById(service.id))?.advanced).toEqual(service.advanced);
    },
  );

  it.each(["native", "http"] as const)(
    "%s retains same-stack sharing settings",
    async (transport) => {
      const { project, service, clients } = await setup();
      const advanced = { networkMode: "service:vpn", pidMode: "service:vpn" };
      await clients[transport].services.update(project.id, service.id, { advanced });
      expect((await repos.service.findById(service.id))?.advanced).toMatchObject(advanced);
    },
  );
});
