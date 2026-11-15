import "../jobs/_env";
import { expect, it } from "vitest";
import { Hono } from "hono";
import { seedOwner, repos } from "../jobs/_harness";
import { seedProject, seedDeployment } from "../../helpers/seed";
import { listDeployments } from "@repo/platform/engine/modules/deployments/deployment.service";
import { projectRoutes } from "../../../src/modules/projects/project.routes";
import { handleApiError } from "../../../src/middleware/error-handler";

const app = new Hono().onError(handleApiError).route("/api/projects", projectRoutes);

it("persists an icon override through authenticated settings, protects it against discovery and restores automatic mode", async () => {
  const owner = await seedOwner();
  const project = await seedProject(owner.orgId);
  const automatic = "https://app.example.test/favicon.ico";
  const custom = "https://cdn.example.test/project.svg";
  await repos.project.updateFaviconCache(project.id, { favicon: automatic });
  const update = (iconUrl: unknown, auth = owner.auth) =>
    app.request(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ iconUrl }),
    });
  const saved = await update(custom);
  expect(saved.status, await saved.clone().text()).toBe(200);
  expect(await saved.json()).toMatchObject({ data: { iconUrl: custom, favicon: custom } });
  await seedDeployment(project);
  for (const options of [{ projectId: project.id }, {}]) {
    const history = await listDeployments(owner.orgId, options);
    expect(history.rows[0]).toMatchObject({ favicon: custom, iconUrl: custom });
  }
  await repos.project.updateFaviconCache(project.id, {
    favicon: "https://app.example.test/new-auto.ico",
  });
  expect(await repos.project.findById(project.id)).toMatchObject({
    iconUrl: custom,
    favicon: automatic,
  });
  const stranger = await seedOwner();
  expect((await update("https://stranger.example.test/icon.png", stranger.auth)).status).toBe(404);
  for (const unsafe of [
    "javascript:alert(1)",
    "data:image/png;base64,AAA",
    "https://user:password@example.test/i.png",
    "/relative.png",
  ])
    expect((await update(unsafe)).status).toBe(400);
  const cleared = await update(null);
  expect(cleared.status).toBe(200);
  expect(await cleared.json()).toMatchObject({ data: { iconUrl: null, favicon: automatic } });
});
