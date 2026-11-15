import "../jobs/_env";
import { expect, it } from "vitest";
import { Hono } from "hono";
import { seedOwner, repos } from "../jobs/_harness";
import { seedProject, seedDeployment } from "../../helpers/seed";
import { listDeployments } from "@repo/platform/engine/modules/deployments/deployment.service";
import { projectRoutes } from "../../../src/modules/projects/project.routes";
import { handleApiError } from "../../../src/middleware/error-handler";

const app = new Hono().onError(handleApiError).route("/api/projects", projectRoutes);

it("uses one icon URL across authenticated settings, reads and deployment history", async () => {
  const owner = await seedOwner();
  const project = await seedProject(owner.orgId);
  const custom = "https://cdn.example.test/project.svg";
  const update = (iconUrl: unknown, auth = owner.auth) =>
    app.request(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ iconUrl }),
    });
  const assertIcon = (data: unknown, expected: string | null) => {
    expect(data).toMatchObject({ iconUrl: expected });
    expect(data).not.toHaveProperty("favicon");
    expect(data).not.toHaveProperty("faviconCheckedAt");
  };
  const saved = await update(`  ${custom}  `);
  expect(saved.status, await saved.clone().text()).toBe(200);
  assertIcon((await saved.json()).data, custom);
  assertIcon(await repos.project.findById(project.id), custom);
  const read = await app.request(`/api/projects/${project.id}`, { headers: owner.auth });
  expect(read.status, await read.clone().text()).toBe(200);
  assertIcon((await read.json()).data, custom);
  await seedDeployment(project);
  for (const options of [{ projectId: project.id }, {}]) {
    const history = await listDeployments(owner.orgId, options);
    assertIcon(history.rows[0], custom);
  }
  const stranger = await seedOwner();
  expect((await update("https://stranger.example.test/icon.png", stranger.auth)).status).toBe(404);
  for (const unsafe of [
    "javascript:alert(1)",
    "data:image/png;base64,AAA",
    "https://user:password@example.test/i.png",
    "/relative.png",
  ])
    expect((await update(unsafe)).status).toBe(400);
  assertIcon(await repos.project.findById(project.id), custom);
  for (const reset of [null, ""]) {
    expect((await update(custom)).status).toBe(200);
    const cleared = await update(reset);
    expect(cleared.status).toBe(200);
    assertIcon((await cleared.json()).data, null);
    assertIcon(await repos.project.findById(project.id), null);
    const history = await listDeployments(owner.orgId, { projectId: project.id });
    assertIcon(history.rows[0], null);
  }
});
