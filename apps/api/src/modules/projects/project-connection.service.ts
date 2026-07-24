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
import { ValidationError } from "@repo/core";
import { getRuntimeTemplate } from "../apps/catalog-source";
import type { RequestContext } from "../../lib/request-context";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import { permission } from "../../lib/permission";
import { getAppConnectionView } from "../apps/app-settings.service";
import { mergeEnvVars } from "./project-env.service";
import { toInternalUrl } from "./project-connection.util";

const ENVIRONMENT = "production";
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

export async function createConnection(
  ctx: RequestContext,
  targetProjectId: string,
  input: CreateConnectionInput,
): Promise<{ connection: ConnectionView; requiresRedeploy: true }> {
  const envKey = input.envKey.trim();
  if (!ENV_KEY_RE.test(envKey)) {
    throw new ValidationError("Enter a valid environment variable name (letters, digits, _).");
  }
  const mode: ConnectionMode = input.mode === "internal" ? "internal" : "public";

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

  let value = output.value;
  if (mode === "internal") {
    // Rewrite host → the source app's internal service alias (needs an app
    // template with a matching endpoint — i.e. a services-type DB app on its own
    // `openship-<slug>` network). If it can't, internal isn't viable here.
    const internal = toInternalUrl(value, getRuntimeTemplate(source.appTemplateId ?? ""));
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

  return {
    connection: toConnectionView(row, source),
    requiresRedeploy: true,
  };
}

export async function deleteConnection(
  ctx: RequestContext,
  targetProjectId: string,
  linkId: string,
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
  return { requiresRedeploy: true };
}
