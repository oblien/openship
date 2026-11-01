import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { db, eq, repos, schema, withAdvisoryLock } from "@repo/db";
import {
  AppError,
  isValidCustomHostname,
  normalizeCustomHostname,
  instanceOrigin,
} from "@repo/core";
import { freezeContext, type ExecutionContext, type PlatformKernel } from "@repo/platform";
import type { TCreateServiceBody } from "@repo/contracts";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { readApiVersion } from "@repo/platform/engine/lib/release-resolver";
import { assertInstanceAdmin } from "../../../middleware/instance-admin";
import { controllerState } from "./controller-state";
import { assertHandoffAccount, assertPortableInstance } from "./portability";
import * as peer from "./handoff-peer";
import { resumeHandoff } from "./handoff-client";

export const provisionInput = z.object({
  serverId: z.string().min(1).max(200),
  access: z.enum(["desktop", "browser"]),
  domain: z.object({ kind: z.enum(["custom", "free"]), hostname: z.string().min(1).max(253) }),
  mapping: z.object({ sourceServerId: z.string(), connectionServerId: z.string() }).optional(),
  confirmed: z.literal(true),
});
export type ProvisionInput = z.infer<typeof provisionInput>;
type Provisioning = NonNullable<typeof schema.instanceHandoff.$inferSelect.provisioning>;
const working = new Map<string, Promise<void>>();
export const provisioningRunning = (id: string) => working.has(id);

function domain(input: ProvisionInput["domain"]) {
  const hostname = normalizeCustomHostname(input.hostname);
  if (input.kind === "free") {
    if (!/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/.test(hostname))
      throw new AppError("Use a free address with letters, numbers and dashes.", 400);
  } else if (!isValidCustomHostname(hostname) || hostname.startsWith("*."))
    throw new AppError("Choose one valid hostname for your instance.", 400);
  return { kind: input.kind, hostname };
}

export async function beginProvisioning(
  ctx: ExecutionContext,
  input: ProvisionInput,
  origin: string,
): Promise<string> {
  await assertInstanceAdmin(ctx);
  await assertHandoffAccount(ctx.userId);
  if ((await controllerState()).role !== "active")
    throw new AppError("Move from the active instance.", 409);
  const address = domain(input.domain);
  await assertPortableInstance(input.mapping);
  const kernel = getPlatformKernel();
  const server = (await kernel.servers.get(ctx, input.serverId)).data;
  if (server.isLocal)
    throw new AppError("Choose another connected server for the new control plane.", 409);
  const code = await peer.createHandoffOffer({
    direction: "source",
    ownerUserId: ctx.userId,
    origin,
    mapping: input.mapping,
  });
  await db
    .update(schema.instanceHandoff)
    .set({
      provisioning: {
        organizationId: ctx.organizationId,
        serverId: input.serverId,
        access: input.access,
        domain: address,
        version: readApiVersion(),
      },
    })
    .where(eq(schema.instanceHandoff.id, code.id));
  void provisionInstance(ctx, code.id, origin);
  return code.id;
}

/** This is a recipe for the normal project/service/deployment engine. It never
 * opens a separate SSH/Docker/Oblien execution path or mounts a host Docker socket. */
export async function installControllerServices(
  kernel: PlatformKernel,
  ctx: ExecutionContext,
  projectId: string,
  plan: Provisioning,
  secret: (purpose: string) => string,
  existing: Array<{ id: string; name: string }>,
) {
  const publicUrl = `https://${plan.domain.hostname}${plan.domain.kind === "free" ? ".opsh.io" : ""}`;
  const route = (port: number) => ({
    exposed: true,
    exposedPort: String(port),
    domainType: plan.domain.kind,
    ...(plan.domain.kind === "free"
      ? { domain: plan.domain.hostname }
      : { customDomain: plan.domain.hostname }),
  });
  const specs: TCreateServiceBody[] = [
    {
      name: "api",
      image: `ghcr.io/oblien/openship-api:${plan.version}`,
      volumes: ["instance-data:/data"],
      ...(plan.access === "desktop" ? route(4000) : { exposed: false }),
      environment: {
        NODE_ENV: "production",
        DEPLOY_MODE: "docker",
        OPENSHIP_TARGET: "local",
        CLOUD_MODE: "false",
        PORT: "4000",
        OPENSHIP_AUTH_MODE: "local",
        OPENSHIP_REQUIRE_AUTH: "true",
        OPENSHIP_ALLOW_ZERO_AUTH: "false",
        PGLITE_DATA_DIR: "/data",
        OPENSHIP_JOB_RUNNER: "in-process",
        OPENSHIP_CACHE_STORE: "memory",
        OPENSHIP_RATE_LIMIT_STORE: "memory",
        OPENSHIP_HOST_CONTROL: "false",
        OPENSHIP_PUBLIC_URL: publicUrl,
        OPENSHIP_INSTANCE_PROJECT_ID: projectId,
        OPENSHIP_API_ONLY: String(plan.access === "desktop"),
        TRUST_PROXY: "true",
      },
    },
    ...(plan.access === "browser"
      ? [
          {
            name: "dashboard",
            image: `ghcr.io/oblien/openship-dashboard:${plan.version}`,
            dependsOn: ["api"],
            ...route(3001),
            environment: {
              NODE_ENV: "production",
              PORT: "3001",
              HOSTNAME: "0.0.0.0",
              INTERNAL_API_URL: "http://api:4000",
            },
          },
        ]
      : []),
  ];
  for (const spec of specs) {
    // A successful create followed by a lost response is recovered by the
    // engine's unique service name on this handoff's persisted project.
    const found = existing.find((service) => service.name === spec.name);
    const service =
      found ??
      (await kernel.services.create(ctx, projectId, { ...spec, restart: "unless-stopped" })).data;
    if (spec.name === "api") {
      await kernel.services.setEnvVars(ctx, projectId, service.id, {
        environment: "production",
        vars: [
          { key: "BETTER_AUTH_SECRET", value: secret("encryption"), isSecret: true },
          { key: "INTERNAL_TOKEN", value: secret("internal"), isSecret: true },
          { key: "OPENSHIP_INSTANCE_RECEIVE_TOKEN", value: secret("bootstrap"), isSecret: true },
          { key: "OPENSHIP_INSTANCE_RECEIVE_ID", value: secret("id"), isSecret: false },
        ],
      });
    }
  }
  return instanceOrigin(publicUrl + (plan.access === "browser" ? "/api/proxy" : ""));
}

export function provisionInstance(
  requestContext: ExecutionContext,
  id: string,
  localOrigin: string,
): Promise<void> {
  const prior = working.get(id);
  if (prior) return prior;
  const work = withAdvisoryLock(`instance-provision:${id}`, async () => {
    const row = await peer.journal(id);
    if (!row.provisioning || row.status === "aborted" || (await controllerState()).handoffId !== id)
      throw new AppError("This server move is no longer pending.", 409);
    if (row.peerId) {
      await resumeHandoff(id, localOrigin);
      return;
    }
    let plan = row.provisioning;
    // Keep the setup project with the source controller until the durable
    // handoff transfers it, including when the destination is a linked Cloud server.
    const ctx = freezeContext({
      ...requestContext,
      organizationId: plan.organizationId,
      scopeMode: "fixed",
    });
    await assertInstanceAdmin(ctx);
    const kernel = getPlatformKernel();
    await kernel.servers.get(ctx, plan.serverId); // re-authorize on every resume
    await db
      .update(schema.instanceHandoff)
      .set({ error: null })
      .where(eq(schema.instanceHandoff.id, id));
    const local = await peer.localPeerCode(id, localOrigin);
    const secret = (purpose: string) =>
      purpose === "id"
        ? id
        : createHmac("sha256", Buffer.from(local.key, "base64url"))
            .update(`controller:${purpose}`)
            .digest("base64url");
    const save = async (patch: Partial<Provisioning>) => {
      plan = { ...plan, ...patch };
      await db
        .update(schema.instanceHandoff)
        .set({ provisioning: plan })
        .where(eq(schema.instanceHandoff.id, id));
    };
    if (!plan.projectId) {
      const slug = `openship-instance-${id}`;
      const found = await repos.project.findBySlugInOrg(ctx.organizationId, slug);
      const project =
        found ??
        (
          await kernel.projects.create(ctx, {
            name: slug,
            slug,
            serverId: plan.serverId,
            framework: "docker-compose",
            projectType: "services",
            isApp: true,
            hasBuild: false,
          })
        ).data;
      if (project.serverId !== plan.serverId)
        throw new AppError("The control-plane project belongs to another server.", 409);
      await save({ projectId: project.id });
    }
    const projectId = plan.projectId!;
    const remoteOrigin = await installControllerServices(
      kernel,
      ctx,
      projectId,
      plan,
      secret,
      await repos.service.listByProject(projectId),
    );
    const previousDeployment = plan.deploymentId
      ? await repos.deployment.findById(plan.deploymentId)
      : null;
    if (!previousDeployment || ["failed", "cancelled"].includes(previousDeployment.status)) {
      const latest = (await repos.deployment.listByProject(projectId)).rows[0];
      if (latest) await save({ deploymentId: latest.id });
      else {
        const { data } = await kernel.deployments.create(ctx, {
          projectId,
          serverId: plan.serverId,
        });
        await save({ deploymentId: data.deployment_id });
      }
    }
    const deadline = Date.now() + 20 * 60_000;
    while (true) {
      const deployment = await repos.deployment.findById(plan.deploymentId!);
      if (deployment?.status === "ready") break;
      if (!deployment || ["failed", "cancelled"].includes(deployment.status))
        throw new AppError(
          "The new instance could not start. Open its deployment, fix the reported issue and redeploy, then resume this move.",
          409,
        );
      if (Date.now() > deadline)
        throw new AppError(
          "The server is still preparing. Check its deployment and resume when it is ready.",
          409,
        );
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    // HTTPS and protocol readiness are checked BEFORE freezing the source. An
    // older image cannot accidentally receive data just because /health is green.
    const response = await fetch(`${remoteOrigin}/api/system/instance/bootstrap`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
      headers: {
        authorization: `Bearer ${secret("bootstrap")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ peer: local, ownerUserId: row.ownerUserId }),
    });
    if (!response.ok)
      throw new AppError(
        `The new instance is not ready for a secure handoff (HTTP ${response.status}). Check its domain and that both instances use Openship ${plan.version}, then resume.`,
        409,
      );
    const result = z
      .object({ code: peer.handoffCodeSchema, version: z.literal(plan.version) })
      .safeParse(await response.json().catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "api/modules/system/instance/provision-instance"); return null; }));
    if (!result.success)
      throw new AppError(
        `The receiving API must run Openship ${plan.version}. Check its image and public address, then resume this move.`,
        409,
      );
    if (result.data.code.origin !== remoteOrigin)
      throw new AppError(
        "The new instance advertises a different API address. Check its public URL.",
        409,
      );
    await peer.bindPeer(id, result.data.code);
    await resumeHandoff(id, localOrigin);
  })
    .catch(async (error) => {
      observeCaughtError(error, "api/modules/system/instance/provision-instance");
      await db
        .update(schema.instanceHandoff)
        .set({
          error:
            error instanceof Error ? error.message : "Server preparation failed. Resume to retry.",
        })
        .where(eq(schema.instanceHandoff.id, id));
    })
    .finally(() => working.delete(id));
  working.set(id, work);
  return work;
}
