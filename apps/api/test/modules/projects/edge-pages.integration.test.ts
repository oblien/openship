import { expect, it } from "vitest";
import { Hono } from "hono";
import { repos, seedOwner } from "../jobs/_harness";
import { OpenshipClient } from "@repo/sdk/client";
import { projectRoutes } from "../../../src/modules/projects/project.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import type { ProjectEdgePages } from "@repo/core";

const app = new Hono()
  .onError(handleApiError)
  .route("/api/health", healthRoutes)
  .route("/api/projects", projectRoutes);
const remote = (token: string, organizationId: string) =>
  new OpenshipClient({
    baseUrl: "http://openship.test",
    token,
    organizationId,
    fetch: ((url, init) => app.request(url as string, init)) as typeof fetch,
  }).projects;

it("persists staged pages through the SDK/HTTP boundary with revision, scope and ownership checks", async () => {
  const owner = await seedOwner();
  const group = await repos.projectGroup.create({
    organizationId: owner.orgId,
    name: "Pages",
    slug: "pages",
  });
  const project = await repos.project.create({
    organizationId: owner.orgId,
    groupId: group.id,
    name: "Pages",
    slug: "pages",
  });
  const client = remote(owner.token, owner.orgId);
  const original = await client.getEdgePages(project.id);
  expect(original).toMatchObject({ config: {}, status: "unpublished" });
  const config: ProjectEdgePages = {
    defaults: {
      files: [
        {
          id: "maintenance",
          name: "maintenance.html",
          html: '<!doctype html><h1>Upgrade</h1><script>document.title="Maintenance"</script>',
        },
      ],
      errors: [{ status: 503, pageId: "maintenance" }],
      maintenance: { enabled: true, pageId: "maintenance", retryAfter: 300 },
    },
  };
  const saved = await client.updateEdgePages(project.id, {
    config,
    expectedRevision: original.revision,
  });
  expect(saved).toMatchObject({ config, status: "unpublished" });
  expect(saved.revision).not.toBe(original.revision);
  expect(await client.getEdgePages(project.id)).toEqual(saved);
  await expect(
    client.updateEdgePages(project.id, { config: {}, expectedRevision: original.revision }),
  ).rejects.toMatchObject({ statusCode: 409 });
  await expect(
    client.updateEdgePages(project.id, {
      config: { hosts: { "other.test": config.defaults! } },
      expectedRevision: saved.revision,
    }),
  ).rejects.toMatchObject({ statusCode: 400 });
  // Routing forms/source imports cannot clear maintenance or overwrite it from
  // a stale configuration object. Only the revision-checked pages operation can.
  await client.update(project.id, { routingConfig: { cleanUrls: true } });
  expect((await client.getEdgePages(project.id)).config).toEqual(config);
  await expect(
    client.update(project.id, { routingConfig: { edgePages: {} } }),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect((await repos.project.findById(project.id))?.routingConfig?.edgePages).toEqual(config);
  const stranger = await seedOwner();
  const foreign = remote(stranger.token, stranger.orgId);
  await expect(foreign.getEdgePages(project.id)).rejects.toMatchObject({ statusCode: 404 });
  await expect(
    foreign.updateEdgePages(project.id, { config: {}, expectedRevision: saved.revision }),
  ).rejects.toMatchObject({ statusCode: 404 });
  await expect(
    client.updateEdgePages(project.id, {
      config: {
        defaults: { ...config.defaults!, errors: [{ status: 401 as 503, pageId: "maintenance" }] },
      },
      expectedRevision: saved.revision,
    }),
  ).rejects.toMatchObject({ statusCode: 400 });
  const reset = await client.updateEdgePages(project.id, {
    config: {},
    expectedRevision: saved.revision,
  });
  expect(reset.config).toEqual({});
  expect((await repos.project.findById(project.id))?.routingConfig?.cleanUrls).toBe(true);
});
