/**
 * Service connections — wire a database app (source project) into a consumer
 * (target) project: inject one resolved connection URL as a project-level secret
 * env var, and (internal mode) mark that the target should join the source's
 * network at deploy. One DB instance, many links — no duplication.
 *
 * Security: the caller must be able to READ the source and WRITE the target, and
 * both must live in the SAME org (no cross-tenant credential flow). The injected
 * URL is encrypted at rest (via the project env merge path).
 */

import { repos } from "@repo/db";
import { ValidationError, isValidEnvKey, getAppEndpoints } from "@repo/core";
import { getTemplateForOrg } from "../apps/catalog-source";
import type { RequestContext } from "../../lib/request-context";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import { permission } from "../../lib/permission";
import { getAppConnectionView } from "../apps/app-settings.service";
import { mergeEnvVars } from "./project-env.service";
import { toInternalUrl } from "./project-connection.util";

const ENVIRONMENT = "production";

export type ConnectionMode = "internal" | "public";

export interface ConnectionView {
  id: string;
  sourceProjectId: string;
  sourceName: string;
  sourceAppTemplateId: string | null;
  targetProjectId: string;
  outputId: string;
  envKey: string;
  mode: ConnectionMode;
}

/**
 * Build the API view of a connection from its link row + the (maybe-missing)
 * source project. Single source so `listConnections` and `createConnection`
 * can't drift on shape or fallbacks.
 */
function toConnectionView(
  link: {
    id: string;
    sourceProjectId: string;
    targetProjectId: string;
    outputId: string;
    envKey: string;
    mode: string;
  },
  source: { name: string; appTemplateId: string | null } | null | undefined,
): ConnectionView {
  return {
    id: link.id,
    sourceProjectId: link.sourceProjectId,
    sourceName: source?.name ?? "Unknown",
    sourceAppTemplateId: source?.appTemplateId ?? null,
    targetProjectId: link.targetProjectId,
    outputId: link.outputId,
    envKey: link.envKey,
    mode: link.mode as ConnectionMode,
  };
}

export async function listConnections(
  ctx: RequestContext,
  targetProjectId: string,
): Promise<ConnectionView[]> {
  await permission.assert(ctx, {
    resourceType: "project",
    resourceId: targetProjectId,
    action: "read",
  });
  const links = await repos.projectConnection.listByTarget(targetProjectId);
  const out: ConnectionView[] = [];
  for (const l of links) {
    const src = await repos.project.findById(l.sourceProjectId);
    out.push(toConnectionView(l, src));
  }
  return out;
}

export interface CreateConnectionInput {
  sourceProjectId: string;
  outputId: string;
  envKey: string;
  /** Normalized here (the single authority) — callers pass it through raw. */
  mode?: ConnectionMode;
}

/**
 * Best-effort: redeploy the consumer so a just-changed connection env actually
 * reaches the RUNNING container (env is baked at deploy time, and internal mode
 * also (re)joins the source network on deploy via attachLinkedNetworks). Non-
 * fatal — mirrors "domains never fail a deploy"; if the target was never
 * deployed there's nothing running to refresh, so it just applies on the first
 * deploy. Dynamic import of the build service avoids a static import cycle.
 */
async function applyConnectionToTarget(
  ctx: RequestContext,
  targetProjectId: string,
): Promise<void> {
  const target = await repos.project.findById(targetProjectId).catch(() => null);
  if (!target?.activeDeploymentId) return;
  try {
    const { triggerDeployment } = await import("../deployments/build.service");
    await triggerDeployment(ctx, { projectId: targetProjectId, trigger: "service-connection" });
  } catch (err) {
    console.warn(
      `[service-connection] apply-redeploy of ${targetProjectId} failed (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export async function createConnection(
  ctx: RequestContext,
  targetProjectId: string,
  input: CreateConnectionInput,
  /** `defer` skips the best-effort apply-redeploy so a bundle redeploys ONCE at
   *  the end instead of per-item. */
  opts?: { defer?: boolean },
): Promise<{ connection: ConnectionView; requiresRedeploy: true }> {
  const envKey = input.envKey.trim();
  if (!isValidEnvKey(envKey)) {
    throw new ValidationError("Enter a valid environment variable name (letters, digits, _).");
  }

  // Both projects must exist, be in the SAME org (no cross-tenant flow), and the
  // caller must be able to read the source + write the target.
  const target = await repos.project.findById(targetProjectId);
  assertResourceInOrg(target, "Project", ctx.organizationId, targetProjectId);
  const source = await repos.project.findById(input.sourceProjectId);
  assertResourceInOrg(source, "Project", target.organizationId, input.sourceProjectId);
  if (source.id === target.id) {
    throw new ValidationError("A project can't connect to itself.");
  }
  await permission.assert(ctx, {
    resourceType: "project",
    resourceId: input.sourceProjectId,
    action: "read",
  });
  await permission.assert(ctx, {
    resourceType: "project",
    resourceId: targetProjectId,
    action: "write",
  });

  // Resolve the connection value from the source app's already-computed outputs.
  const view = await getAppConnectionView(ctx, input.sourceProjectId);
  const output = view.outputs.find((o) => o.id === input.outputId);
  if (!output || !output.value) {
    throw new ValidationError("That connection value isn't available yet on the source app.");
  }

  // Resolve the source app template ONCE — used both to default the reach mode
  // from the endpoint's declared scope and to rewrite the internal host below.
  const template = await getTemplateForOrg(source.organizationId, source.appTemplateId ?? "");

  // Default the reach mode from the source endpoint's declared `scope` when the
  // caller didn't choose: a DB endpoint (scope "internal") wires internal, a
  // UI/API ("public") wires public. An explicit input.mode always wins.
  let mode: ConnectionMode;
  if (input.mode === "internal" || input.mode === "public") {
    mode = input.mode;
  } else {
    const scope =
      output.service && template
        ? getAppEndpoints(template).find((e) => e.service === output.service)?.scope
        : undefined;
    mode = scope === "internal" ? "internal" : "public";
  }

  let value = output.value;
  if (mode === "internal") {
    // Internal reachability rides on joining the source app's docker network at
    // deploy (attachLinkedNetworks). A cloud-hosted source (Oblien) has no
    // attachable shared network on this pipe yet, so an internal alias would be
    // unreachable — steer to Public instead of injecting a dead host.
    const srcDep = source.activeDeploymentId
      ? await repos.deployment.findById(source.activeDeploymentId).catch(() => null)
      : null;
    const srcTarget = (srcDep?.meta as { deployTarget?: string } | null)?.deployTarget;
    if (srcTarget === "cloud") {
      throw new ValidationError(
        "Internal mode isn't available for a cloud-hosted app yet — use Public.",
      );
    }
    // Rewrite host → the source app's internal service alias. The output's
    // declared/derived `service` is authoritative for which alias+port to
    // target; if it can't resolve, internal isn't viable here.
    const internal = toInternalUrl(value, template, output.service);
    if (!internal) {
      throw new ValidationError(
        "Internal mode isn't available for this connection — use Public, or pick a database app's URL.",
      );
    }
    value = internal;
  }

  // Don't silently clobber a manually-set env var: if `envKey` already exists on
  // the target and isn't owned by an existing connection, refuse — disconnect
  // would later delete it, losing the user's own value. Re-connecting an
  // already-connection-owned key is fine (it's an upsert of our own var).
  const [existingVars, existingLinks] = await Promise.all([
    repos.project.listEnvVars(targetProjectId, ENVIRONMENT).catch(() => [] as { key: string }[]),
    repos.projectConnection.listByTarget(targetProjectId).catch(() => [] as { envKey: string }[]),
  ]);
  const connectionOwnedKeys = new Set(existingLinks.map((l) => l.envKey));
  const keyExisted = existingVars.some((v) => v.key === envKey);
  if (keyExisted && !connectionOwnedKeys.has(envKey)) {
    throw new ValidationError(
      `An environment variable "${envKey}" already exists on this project — remove it or choose a different key before connecting (a connection owns its key and removing the connection deletes it).`,
    );
  }

  // Inject the secret env var (encrypted at rest), then record the link. If
  // recording the link fails, roll back the var WE just injected — a secret with
  // no owning link would be orphaned AND the clobber-guard above would then block
  // re-connecting that key forever. Only roll back a FRESHLY-injected key: a
  // re-connect of an already-owned key merely refreshed an existing var, which
  // must survive the failure.
  await mergeEnvVars(targetProjectId, target.organizationId, {
    environment: ENVIRONMENT,
    upserts: [{ key: envKey, value, isSecret: true }],
    deletes: [],
  });

  let row: Awaited<ReturnType<typeof repos.projectConnection.upsert>>;
  try {
    row = await repos.projectConnection.upsert({
      organizationId: target.organizationId,
      sourceProjectId: source.id,
      targetProjectId: target.id,
      outputId: input.outputId,
      envKey,
      mode,
    });
  } catch (err) {
    if (!keyExisted) {
      await mergeEnvVars(targetProjectId, target.organizationId, {
        environment: ENVIRONMENT,
        upserts: [],
        deletes: [envKey],
      }).catch(() => {});
    }
    throw err;
  }

  // Apply immediately to the running consumer (best-effort). A bundle defers so
  // it redeploys once at the end rather than per item.
  if (!opts?.defer) await applyConnectionToTarget(ctx, targetProjectId);

  return {
    connection: toConnectionView(row, source),
    requiresRedeploy: true,
  };
}

export interface ConnectBundleItem {
  outputId: string;
  envKey: string;
}

/**
 * Wire a BUNDLE of outputs from one source app into a target project atomically:
 * either every item links, or none does. On any failure, every connection made
 * in THIS call is rolled back (its injected env var + link removed), so a partial
 * failure never leaves a half-wired mix. Reuses `createConnection` per item, so
 * the same-org + read-source/write-target invariants and clobber-guard apply.
 */
export async function connectBundle(
  ctx: RequestContext,
  targetProjectId: string,
  input: { sourceProjectId: string; items: ConnectBundleItem[]; mode?: ConnectionMode },
): Promise<{ connections: ConnectionView[]; requiresRedeploy: true }> {
  const created: ConnectionView[] = [];
  try {
    for (const item of input.items) {
      const { connection } = await createConnection(
        ctx,
        targetProjectId,
        {
          sourceProjectId: input.sourceProjectId,
          outputId: item.outputId,
          envKey: item.envKey,
          mode: input.mode,
        },
        // Defer the apply-redeploy — we do it ONCE below after all items land,
        // so a multi-output bundle triggers a single consumer redeploy.
        { defer: true },
      );
      created.push(connection);
    }
  } catch (err) {
    // Roll back every link made in this bundle (best-effort) before surfacing.
    for (const c of created) {
      await deleteConnection(ctx, targetProjectId, c.id, { defer: true }).catch(() => {});
    }
    throw err;
  }
  await applyConnectionToTarget(ctx, targetProjectId);
  return { connections: created, requiresRedeploy: true };
}

export async function deleteConnection(
  ctx: RequestContext,
  targetProjectId: string,
  linkId: string,
  /** `defer` skips the apply-redeploy — used by bundle rollback so a failed
   *  bundle doesn't fire a redeploy per rolled-back item. */
  opts?: { defer?: boolean },
): Promise<{ requiresRedeploy: true }> {
  await permission.assert(ctx, {
    resourceType: "project",
    resourceId: targetProjectId,
    action: "write",
  });
  const target = await repos.project.findById(targetProjectId);
  assertResourceInOrg(target, "Project", ctx.organizationId, targetProjectId);

  const link = await repos.projectConnection.findInTarget(linkId, targetProjectId);
  if (!link) throw new ValidationError("Connection not found.");

  // Remove the injected env var, then drop the link.
  await mergeEnvVars(targetProjectId, target.organizationId, {
    environment: ENVIRONMENT,
    upserts: [],
    deletes: [link.envKey],
  });
  await repos.projectConnection.delete(linkId);
  // Refresh the running consumer so the removed env leaves the live container.
  if (!opts?.defer) await applyConnectionToTarget(ctx, targetProjectId);
  return { requiresRedeploy: true };
}
