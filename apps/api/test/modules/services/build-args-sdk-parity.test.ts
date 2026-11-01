import { describe, expect, it } from "vitest";
import { db, schema, repos, seedOwner, installFakeRunner } from "../jobs/_harness";
import { Hono } from "hono";
import { eq } from "@repo/db";
import { ENV_MASK } from "@repo/core";
import { createShip } from "@repo/sdk/native";
import { OpenshipClient } from "@repo/sdk/client";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { flushAudit } from "@repo/platform/engine/lib/audit-emitter";
import { mintPatToken } from "@repo/platform/engine/lib/pat";
import { resolveComposeBuildArgs } from "@repo/platform/engine/modules/deployments/compose/build.service";
import { serviceRoutes } from "../../../src/modules/services/service.routes";
import { deploymentRoutes } from "../../../src/modules/deployments/deployment.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { handleApiError } from "../../../src/middleware/error-handler";

// Real database, authentication, policy, service writes and deployment reads.
// The runner is idle: these configuration operations never contact a host.
installFakeRunner();
const app = new Hono()
  .onError(handleApiError)
  .route("/api/health", healthRoutes)
  .route("/api/projects/:id/services", serviceRoutes)
  .route("/api/deployments", deploymentRoutes);

async function setup() {
  const owner = await seedOwner();
  const input = {
    organizationId: owner.orgId,
    name: "Build arguments",
    slug: `build-args-${owner.userId}`,
    framework: "docker-compose",
  };
  const group = await repos.projectGroup.create(input);
  const project = await repos.project.create({ ...input, groupId: group.id });
  const user = (await repos.user.findById(owner.userId))!;
  const ship = createShip({
    platform: getPlatformKernel(),
    identity: {
      resolve: async () => ({
        user: { id: user.id, email: user.email, name: user.name },
        sessionId: "build-args-test",
      }),
    },
  });
  const remote = (token = owner.token) =>
    new OpenshipClient({
      baseUrl: "http://openship.test",
      token,
      organizationId: owner.orgId,
      fetch: ((url, init) => app.request(url as string, init)) as typeof fetch,
    });
  return {
    owner,
    project,
    remote,
    clients: {
      native: await ship.scope({ identity: "verified", organizationId: owner.orgId }),
      http: remote(),
    },
  };
}

describe("build arguments through the native and HTTP SDK (#854)", () => {
  it.each(["native", "http"] as const)(
    "%s preserves masked edits, empty and inherited arguments, and deletions",
    async (transport) => {
      const { project, clients, owner } = await setup();
      const services = clients[transport].services;
      const created = await services.create(project.id, {
        name: "web",
        kind: "compose",
        build: ".",
        environment: { TOKEN: "runtime-secret" },
        buildArgs: {
          TOKEN: "original-secret",
          TEMPLATE: "${BUILD_TOKEN:-default-secret}",
          LITERAL: "${KEEP_LITERAL}",
          REMOVED: "removed-secret",
          EMPTY: "",
          INHERITED: null,
        },
        advanced: { buildArgTemplateKeys: ["TEMPLATE"] },
      });
      expect(created.buildArgs).toEqual({
        TOKEN: ENV_MASK,
        TEMPLATE: ENV_MASK,
        LITERAL: ENV_MASK,
        REMOVED: ENV_MASK,
        EMPTY: "",
        INHERITED: null,
      });
      expect(Object.keys(created.buildArgsFingerprints!).sort()).toEqual([
        "EMPTY",
        "LITERAL",
        "REMOVED",
        "TOKEN",
      ]);

      const updated = await services.update(project.id, created.id, {
        buildArgs: {
          TOKEN: "rotated-secret",
          TEMPLATE: ENV_MASK,
          LITERAL: ENV_MASK,
          EMPTY: "",
          INHERITED: null,
          GHOST: ENV_MASK,
        },
      });
      expect(updated.buildArgsFingerprints?.TOKEN).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
      expect(updated.buildArgsFingerprints?.TOKEN).not.toBe(created.buildArgsFingerprints?.TOKEN);
      expect(updated.buildArgsFingerprints?.LITERAL).toBe(created.buildArgsFingerprints?.LITERAL);
      expect(updated.advanced?.buildArgTemplateKeys).toEqual(["TEMPLATE"]);
      expect(await repos.service.findById(created.id)).toMatchObject({
        buildArgs: {
          TOKEN: "rotated-secret",
          TEMPLATE: "${BUILD_TOKEN:-default-secret}",
          LITERAL: "${KEEP_LITERAL}",
          EMPTY: "",
          INHERITED: null,
        },
      });
      expect(updated.buildArgs).not.toHaveProperty("REMOVED");
      expect(updated.buildArgs).not.toHaveProperty("GHOST");
      for (const client of Object.values(clients)) {
        expect(await client.services.get(project.id, created.id)).toEqual(updated);
        expect(await client.services.list(project.id)).toEqual([updated]);
      }
      await flushAudit();
      const audit = await db
        .select()
        .from(schema.auditEvent)
        .where(eq(schema.auditEvent.organizationId, owner.orgId));
      expect(audit.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify([created, updated, audit])).not.toContain("-secret");
      expect((await services.update(project.id, created.id, { buildArgs: {} })).buildArgs).toEqual(
        {},
      );
      expect((await repos.service.findById(created.id))?.buildArgs).toEqual({});
    },
  );

  it.each(["native", "http"] as const)(
    "%s sync restores masked source expressions without reinterpreting literals",
    async (transport) => {
      const { project, clients } = await setup();
      const services = clients[transport].services;
      const [created] = await services.sync(project.id, {
        services: [
          {
            name: "web",
            build: ".",
            buildArgs: {
              TEMPLATE: "${BUILD_TOKEN:-default-secret}",
              LITERAL: "${KEEP_LITERAL}",
              EMPTY: "",
              INHERITED: null,
            },
            advanced: { buildArgTemplateKeys: ["TEMPLATE"] },
          },
        ],
      });
      // Minimal edits need not echo `advanced`; the sentinel still preserves the
      // original expression's meaning. A source parser may supply its own marker.
      const [synced] = await services.sync(project.id, {
        services: [
          {
            name: created.name,
            build: ".",
            buildArgs: { ...created.buildArgs, GHOST: ENV_MASK },
          },
        ],
      });
      expect(synced.buildArgs).toEqual(created.buildArgs);
      expect(synced.advanced?.buildArgTemplateKeys).toEqual(["TEMPLATE"]);
      const saved = (await repos.service.findById(created.id))!;
      expect(
        resolveComposeBuildArgs(
          saved.buildArgs,
          {
            BUILD_TOKEN: "final-secret",
            KEEP_LITERAL: "must-not-expand",
            INHERITED: "inherited-secret",
          },
          saved.advanced?.buildArgTemplateKeys,
        ),
      ).toEqual({
        TEMPLATE: "final-secret",
        LITERAL: "${KEEP_LITERAL}",
        EMPTY: "",
        INHERITED: "inherited-secret",
      });
      await services.sync(project.id, {
        services: [
          {
            name: created.name,
            build: ".",
            buildArgs: { TEMPLATE: "${KEEP_LITERAL}" },
            advanced: { buildArgTemplateKeys: [] },
          },
        ],
      });
      const normalized = (await repos.service.findById(created.id))!;
      expect(
        resolveComposeBuildArgs(
          normalized.buildArgs,
          { KEEP_LITERAL: "must-not-expand" },
          normalized.advanced?.buildArgTemplateKeys,
        ),
      ).toEqual({ TEMPLATE: "${KEEP_LITERAL}" });
    },
  );

  it("masks retained history, build status and drift without changing the rollback snapshots", async () => {
    const { project, clients, owner } = await setup();
    const created = await clients.native.services.create(project.id, {
      name: "web",
      kind: "compose",
      build: ".",
      buildArgs: { TOKEN: "old-secret" },
    });
    const prior = (await repos.service.findById(created.id))!;
    const old = (await repos.deployment.create({
      organizationId: owner.orgId,
      projectId: project.id,
      branch: "main",
      status: "ready",
      meta: { composeServices: [prior] },
    }))!;
    const updated = await clients.http.services.update(project.id, created.id, {
      buildArgs: { TOKEN: "new-secret" },
    });
    await repos.service.update(created.id, {
      importedSpec: { buildArgs: { TOKEN: "new-secret" } },
      driftSpec: { buildArgs: { TOKEN: "${TOKEN:-pending-secret}" } },
    });
    const current = (await repos.service.findById(created.id))!;
    const latest = (await repos.deployment.create({
      organizationId: owner.orgId,
      projectId: project.id,
      branch: "main",
      status: "ready",
      meta: { composeServices: [current] },
    }))!;
    const protectedService = (fingerprint: string | undefined) =>
      expect.objectContaining({
        buildArgs: { TOKEN: ENV_MASK },
        buildArgsFingerprints: { TOKEN: fingerprint },
      });
    for (const client of Object.values(clients)) {
      const previous = await client.deployments.get(old.id);
      const recent = await client.deployments.get(latest.id);
      const history = await client.deployments.list({ projectId: project.id });
      const status = await client.deployments.buildStatus(latest.id);
      const service = await client.services.get(project.id, created.id);
      expect(previous.meta).toMatchObject({
        composeServices: [protectedService(created.buildArgsFingerprints?.TOKEN)],
      });
      expect(recent.meta).toMatchObject({
        composeServices: [protectedService(updated.buildArgsFingerprints?.TOKEN)],
      });
      expect(history.data).toHaveLength(2);
      expect(status).toMatchObject({
        composeServices: [protectedService(updated.buildArgsFingerprints?.TOKEN)],
      });
      expect(service.drift?.changes).toContainEqual({
        field: "buildArgs",
        from: { TOKEN: ENV_MASK },
        to: { TOKEN: ENV_MASK },
      });
      const serialized = JSON.stringify([previous, recent, history, status, service]);
      for (const hidden of ["-secret", "importedSpec", "driftSpec"])
        expect(serialized).not.toContain(hidden);
    }
    expect((await repos.deployment.findById(old.id))?.meta).toMatchObject({
      composeServices: [{ buildArgs: { TOKEN: "old-secret" } }],
    });
    expect((await repos.deployment.findById(latest.id))?.meta).toMatchObject({
      composeServices: [{ buildArgs: { TOKEN: "new-secret" } }],
    });
  });

  it("keeps read-only tokens masked and prevents foreign service or deployment reads", async () => {
    const { owner, project, clients, remote } = await setup();
    const service = await clients.native.services.create(project.id, {
      name: "web",
      buildArgs: { TOKEN: "read-only-secret" },
    });
    const token = mintPatToken();
    await repos.personalAccessToken.create({
      userId: owner.userId,
      organizationId: owner.orgId,
      name: "reader",
      tokenPrefix: token.tokenPrefix,
      tokenHash: token.tokenHash,
      readOnly: true,
      scoped: false,
      expiresAt: null,
    });
    const reader = remote(token.token);
    expect((await reader.services.get(project.id, service.id)).buildArgs).toEqual({
      TOKEN: ENV_MASK,
    });
    await expect(
      reader.services.update(project.id, service.id, { buildArgs: { TOKEN: "changed" } }),
    ).rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
    const foreign = await setup();
    const foreignService = await foreign.clients.native.services.create(foreign.project.id, {
      name: "web",
      buildArgs: { TOKEN: "foreign-secret" },
    });
    const deployment = (await repos.deployment.create({
      organizationId: foreign.owner.orgId,
      projectId: foreign.project.id,
      branch: "main",
      status: "ready",
    }))!;
    for (const client of Object.values(clients)) {
      await expect(
        client.services.get(foreign.project.id, foreignService.id),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(client.services.get(project.id, foreignService.id)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(client.deployments.get(deployment.id)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    }
  });
});
