import { expect, it } from "vitest";
import { Hono } from "hono";
import { repos, seedOwner } from "../jobs/_harness";
import { db, schema } from "@repo/db";
import { eq } from "drizzle-orm";
import { createRouteProtection } from "@repo/adapters";
import { registerProjectRoute } from "@repo/platform/engine/lib/project-route-registration";
import { previewEnvironmentInput } from "@repo/platform/engine/modules/projects/pull-request-previews";
import { createShip } from "@repo/sdk/native";
import { OpenshipClient } from "@repo/sdk/client";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { projectRoutes } from "../../../src/modules/projects/project.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { handleApiError } from "../../../src/middleware/error-handler";

const app = new Hono()
  .onError(handleApiError)
  .route("/api/health", healthRoutes)
  .route("/api/projects", projectRoutes);

it("shares pending protection through real native/HTTP operations without leaking credentials or crossing tenants", async () => {
  const owner = await seedOwner();
  const user = (await repos.user.findById(owner.userId))!;
  const group = await repos.projectGroup.create({
    organizationId: owner.orgId,
    name: "Private site",
    slug: "private-site",
  });
  const project = await repos.project.create({
    organizationId: owner.orgId,
    groupId: group.id,
    name: "Private site",
    slug: "private-site",
  });
  const native = await createShip({
    platform: getPlatformKernel(),
    identity: {
      resolve: async () => ({
        user: { id: user.id, email: user.email, name: user.name },
        sessionId: "route-protection-test",
      }),
    },
  }).scope({ identity: "verified", organizationId: owner.orgId });
  const remote = (token: string, organizationId: string) =>
    new OpenshipClient({
      baseUrl: "http://openship.test",
      token,
      organizationId,
      fetch: ((url, init) => app.request(url as string, init)) as typeof fetch,
    }).projects;
  const client = remote(owner.token, owner.orgId);
  const input = {
    hostname: "private.test",
    action: "protect" as const,
    password: "private-browser-password",
  };

  const pending = await native.projects.changeRouteProtection(project.id, input);
  expect(pending).toEqual({ hostname: input.hostname, enabled: true, status: "pending" });
  expect(await client.listRouteProtection(project.id)).toEqual([pending]);
  expect(JSON.stringify(pending)).not.toContain(input.password);
  expect(
    await client.changeRouteProtection(project.id, { hostname: input.hostname, action: "retry" }),
  ).toEqual(pending);
  const policy = (await repos.routeProtection.readPrivate(project.id, input.hostname))!.secret!;

  const other = await seedOwner();
  const stranger = remote(other.token, other.orgId);
  await expect(stranger.listRouteProtection(project.id)).rejects.toMatchObject({ statusCode: 404 });
  await expect(
    stranger.changeRouteProtection(project.id, { hostname: input.hostname, action: "unlock" }),
  ).rejects.toMatchObject({ statusCode: 404 });
  expect((await repos.routeProtection.readPrivate(project.id, input.hostname))!.secret).toBe(
    policy,
  );

  await expect(
    client.changeRouteProtection(project.id, { ...input, password: "short" }),
  ).rejects.toMatchObject({ statusCode: 400 });
  await client.changeRouteProtection(project.id, { hostname: input.hostname, action: "unlock" });
  expect(await native.projects.listRouteProtection(project.id)).toEqual([
    { hostname: input.hostname, enabled: false, status: "pending" },
  ]);

  // A queued writer can retain an old project snapshot after teardown finishes.
  await db.delete(schema.project).where(eq(schema.project.id, project.id));
  let published = false;
  await expect(
    registerProjectRoute(
      project,
      {
        registerRoute: async () => {
          published = true;
        },
      },
      { domain: input.hostname, tls: true, targetUrl: "http://127.0.0.1:3000" },
    ),
  ).rejects.toMatchObject({ code: "PROJECT_DELETION_PENDING" });
  expect(published).toBe(false);
});

it("protects two native preview identities before first publication and cascades their private policy on cleanup", async () => {
  const owner = await seedOwner();
  const group = await repos.projectGroup.create({
    organizationId: owner.orgId,
    name: "Previews",
    slug: "private-previews",
  });
  const source = await repos.project.create({
    organizationId: owner.orgId,
    groupId: group.id,
    name: "Source",
    slug: "private-source",
    environmentType: "development",
    gitOwner: "owner",
    gitRepo: "repo",
    gitBranch: "main",
    previewSettings: {
      enabled: true,
      comments: false,
      baseDomain: "preview.test",
      protectionHostname: "dev.test",
    },
  });
  const policy = await createRouteProtection("native-preview-test-password");
  await repos.routeProtection.save(source.id, "dev.test", "source-first", JSON.stringify(policy));
  const keys: string[] = [];
  const children: string[] = [];
  for (const number of [1, 2]) {
    await repos.pullRequestPreview.enqueue({
      organizationId: owner.orgId,
      sourceProjectId: source.id,
      owner: "owner",
      repo: "repo",
      number,
    });
    const intent = (await repos.pullRequestPreview.list(source.id, owner.orgId)).find(
      (row) => row.number === number,
    )!;
    const token = `lease-${number}`;
    await repos.pullRequestPreview.claim(intent.id, token);
    const child = await repos.pullRequestPreview.createEnvironment(
      intent.id,
      token,
      previewEnvironmentInput(source, [], number, `feature-${number}`),
    );
    children.push(child.id);
    expect((await repos.pullRequestPreview.findByProject(child.id))?.sourceProjectId).toBe(
      source.id,
    );
    const hostname = `${child.slug}.preview.test`;
    await repos.domain.create({ projectId: child.id, hostname, domainType: "custom" });
    let publications = 0;
    const routing = {
      registerRoute: async (route: { protection?: unknown }) => {
        const stored = await repos.routeProtection.readPrivate(child.id, hostname);
        expect(stored?.enabled).toBe(true);
        expect(JSON.parse(stored!.secret!)).toEqual(route.protection);
        keys.push(JSON.parse(stored!.secret!).signingKey);
        publications++;
      },
    };
    await registerProjectRoute(child, routing, {
      domain: hostname,
      tls: true,
      targetUrl: "http://127.0.0.1:3000",
    });
    expect(publications).toBe(1);
    expect(await repos.project.getEnvMap(child.id, "production", null)).toEqual({});
    const [stored] = await db
      .select()
      .from(schema.routeProtection)
      .where(eq(schema.routeProtection.projectId, child.id));
    expect(stored.secret).not.toContain(policy.verifier);
    expect(stored.secret).not.toContain(keys.at(-1)!);
  }
  expect(new Set(keys).size).toBe(2);
  expect(keys).not.toContain(policy.signingKey);
  for (const id of children) {
    expect(await repos.routeProtection.list(id)).toHaveLength(1);
    await db.delete(schema.project).where(eq(schema.project.id, id));
    expect(await repos.routeProtection.list(id)).toEqual([]);
    expect(await repos.pullRequestPreview.findByProject(id)).toBeUndefined();
  }
});
