import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { repos } from "@repo/db";
import { DEFAULT_GITHUB_DEPLOYMENT_CHECKS } from "@repo/core";
import { seedOwner } from "../jobs/_harness";
import { createShip } from "@repo/sdk/native";
import { OpenshipClient } from "@repo/sdk/client";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { projectRoutes } from "../../../src/modules/projects/project.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { handleApiError } from "../../../src/middleware/error-handler";

const app = new Hono().onError(handleApiError).route("/api/health", healthRoutes).route("/api/projects", projectRoutes);
async function clients() {
  const owner = await seedOwner();
  const user = (await repos.user.findById(owner.userId))!;
  const ship = createShip({ platform: getPlatformKernel(), identity: { resolve: async () => ({
    user: { id: user.id, email: user.email, name: user.name }, sessionId: "deployment-checks-test",
  }) } });
  return [await ship.scope({ identity: "verified", organizationId: owner.orgId }),
    new OpenshipClient({ baseUrl: "http://openship.test", token: owner.token, organizationId: owner.orgId,
      fetch: ((url, init) => app.request(url as string, init)) as typeof fetch })];
}
describe("GitHub deployment settings through native SDK and HTTP", () => {
  it("persists wizard preferences, preserves omission, and permits opt-out or resetting defaults", async () => {
    for (const [index, client] of (await clients()).entries()) {
      const config = { ...DEFAULT_GITHUB_DEPLOYMENT_CHECKS, services: ["web"], includeErrors: false };
      const project = await client.projects.create({ name: `Deployment checks ${index}`, publicEndpoints: [], githubChecks: config });
      expect(project.githubChecks).toEqual(config);
      await client.projects.setOptions(project.id, { startCommand: "node app.js" });
      expect((await client.projects.get(project.id)).githubChecks).toEqual(config);
      await client.projects.setOptions(project.id, { githubChecks: { ...config, enabled: false } });
      expect((await client.projects.get(project.id)).githubChecks?.enabled).toBe(false);
      await client.projects.ensure({ projectId: project.id, name: project.name, publicEndpoints: [] });
      expect((await client.projects.get(project.id)).githubChecks?.enabled).toBe(false);
      await client.projects.setOptions(project.id, { githubChecks: null });
      expect((await client.projects.get(project.id)).githubChecks).toBeNull();
    }
  });
  it("rejects malformed preferences before changing saved configuration", async () => {
    for (const [index, client] of (await clients()).entries()) {
      const project = await client.projects.create({ name: `Invalid deployment checks ${index}`, publicEndpoints: [] });
      for (const value of [false, {}, { ...DEFAULT_GITHUB_DEPLOYMENT_CHECKS, services: [1] }, { ...DEFAULT_GITHUB_DEPLOYMENT_CHECKS, services: ["web", "web"] }])
        await expect(client.projects.setOptions(project.id, { githubChecks: value } as never)).rejects.toThrow();
      expect((await repos.project.findById(project.id))?.githubChecks).toBeNull();
    }
  });
});
