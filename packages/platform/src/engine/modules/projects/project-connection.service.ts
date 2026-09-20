/**
 * Service connections — wire a database app (source project) into a consumer
 * (target) project: inject one resolved connection URL as a project-level secret
 * env var, and (internal mode) mark that the target should join the source's
 * network at deploy. One DB instance, many links — no duplication.
 *
 * Security: the caller must be able to WRITE the source and target, and
 * both must live in the SAME org (no cross-tenant credential flow). The injected
 * URL is encrypted at rest and saved atomically with its link.
 */

import { findActiveDeployment } from "@repo/platform/engine/lib/active-deployment";
import { repos, type Project } from "@repo/db";
import {
  ValidationError,
  isValidEnvKey,
  getAppEndpoints,
  getAppConnection,
  getOutputPort,
  type AppTemplate,
} from "@repo/core";
import { getTemplateForOrg } from "../apps/catalog-source";
import type { ExecutionContext as RequestContext } from "@repo/platform";
import { assertResourceInOrg } from "../../lib/resource-access";
import { isLocalHostRow } from "../../lib/box-org";
import { authorization } from "../../lib/authorization";
import { getAppConnectionView, type AppConnectionOutput } from "../apps/app-settings.service";
import { mergeEnvVars } from "./project-env.service";
import { toInternalUrl, isNetworkUrl, usesPrivateNetwork } from "./project-connection.util";
import { sharedServiceAlias, ensureSharedServiceNetwork, disconnectSharedServiceNetwork } from "./shared-service-network";
import { encrypt, decrypt } from "../../lib/encryption";
import { listAuthorizedProjects } from "../../lib/authorized-projects";
import { withProjectRuntimeLock } from "../../lib/project-runtime-lock";

const ENVIRONMENT = "production";

/** Match service/project deletion locks; a stable order also allows reciprocal links. */
function withConnectionLocks<T>(sourceId: string, targetId: string, run: () => Promise<T>): Promise<T> {
  const [first, second] = [sourceId, targetId].sort();
  return withProjectRuntimeLock(first, () => withProjectRuntimeLock(second, run));
}

/** Both connection pickers use the same uncapped, permission-filtered choices. */
export async function listConnectionCandidates(ctx: RequestContext, projectId: string) {
  ctx = await authorization.authorize(ctx, { resourceType: "project", resourceId: projectId, action: "write" });
  const candidates = [];
  for (const project of await listAuthorizedProjects(ctx, ctx.organizationId)) {
    if (project.id === projectId || !(await authorization.checkPermissionOnResource(
      { ...ctx, scopeMode: "fixed" }, { resourceType: "project", resourceId: project.id, action: "write" },
    ))) continue;
    candidates.push({ id: project.id, name: project.name, description: project.environmentName, appTemplateId: project.appTemplateId });
  }
  return candidates.sort((a, b) => a.name.localeCompare(b.name));
}

export type ConnectionMode = "internal" | "public";

export interface ConnectionView {
  id: string;
  sourceProjectId: string;
  sourceName: string;
  sourceAppTemplateId: string | null;
  sourceServiceId: string | null;
  sourceServiceName: string | null;
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
    sourceServiceId?: string | null;
    targetProjectId: string;
    outputId: string;
    envKey: string;
    mode: string;
  },
  source: { name: string; appTemplateId: string | null } | null | undefined,
  sourceServiceName: string | null = null,
): ConnectionView {
  return {
    id: link.id,
    sourceProjectId: link.sourceProjectId,
    sourceName: source?.name ?? "Unknown",
    sourceAppTemplateId: source?.appTemplateId ?? null,
    sourceServiceId: link.sourceServiceId ?? null,
    sourceServiceName,
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
  ctx = await authorization.authorize(ctx, {
    resourceType: "project",
    resourceId: targetProjectId,
    action: "read",
  });
  const links = await repos.projectConnection.listByTarget(targetProjectId);
  const out: ConnectionView[] = [];
  for (const l of links) {
    const src = await repos.project.findById(l.sourceProjectId);
    const service = l.sourceServiceId ? await repos.service.findById(l.sourceServiceId) : null;
    out.push(toConnectionView(l, src, service?.name ?? null));
  }
  return out;
}

/** One project consuming THIS app — the reverse of {@link listConnections}. */
export interface ConnectionConsumerView {
  id: string;
  sourceServiceId: string | null;
  targetProjectId: string;
  targetName: string;
  targetSlug: string | null;
  outputId: string;
  envKey: string;
  mode: ConnectionMode;
}

/**
 * Who consumes this app — the SOURCE side of the graph.
 *
 * A shared database is the normal case (app A and app B both wired to Postgres
 * app C: the unique index is on `(targetProjectId, envKey)`, so one source feeds
 * as many consumers as you like). Without this the relationship was only visible
 * from each consumer, so the shared app's own page couldn't show what depends on
 * it — and deleting it hit an FK error naming a constraint instead of the apps.
 *
 * Read access on the source is enough: it exposes which projects in the SAME org
 * consume it and under which env key, no connection values.
 */
export async function listConsumers(
  ctx: RequestContext,
  sourceProjectId: string,
): Promise<ConnectionConsumerView[]> {
  ctx = await authorization.authorize(ctx, {
    resourceType: "project",
    resourceId: sourceProjectId,
    action: "read",
  });
  const source = await repos.project.findById(sourceProjectId);
  assertResourceInOrg(source, "Project", ctx.organizationId, sourceProjectId);

  const links = await repos.projectConnection.listBySource(sourceProjectId);
  const out: ConnectionConsumerView[] = [];
  for (const l of links) {
    const target = await repos.project.findById(l.targetProjectId).catch(() => null);
    // Same-org only. A link can't be cross-org (createConnection enforces it), so
    // a mismatch here means data drift — skip rather than leak a foreign name.
    if (target && target.organizationId !== ctx.organizationId) continue;
    out.push({
      id: l.id,
      sourceServiceId: l.sourceServiceId ?? null,
      targetProjectId: l.targetProjectId,
      targetName: target?.name ?? "Unknown",
      targetSlug: target?.slug ?? null,
      outputId: l.outputId,
      envKey: l.envKey,
      mode: l.mode as ConnectionMode,
    });
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

/** Both authorized ends of a prospective connection plus the chosen output. */
interface ConnectionEnds {
  source: Project;
  target: Project;
  output: AppConnectionOutput;
  sourceServiceName: string | null;
  template: AppTemplate | undefined;
  /** Container port the output's catalog `source` names — see `getOutputPort`. */
  declaredPort: number | null;
}

/**
 * Load and authorize both ends of a connection and resolve the chosen output.
 * Shared by `createConnection` and `internalModeAvailable` so a caller that has to
 * pick a mode BEFORE connecting sees exactly what the create will see.
 */
async function loadConnectionEnds(
  ctx: RequestContext,
  targetProjectId: string,
  sourceProjectId: string,
  outputId: string,
  /** Existing bindings are refreshed under deployment authority, without exposing secrets. */
  opts?: { refresh?: boolean; sourceServiceId?: string | null },
): Promise<ConnectionEnds> {
  // Both projects must exist, be in the SAME org (no cross-tenant flow), and the
  // caller must be able to write the source and target.
  const target = await repos.project.findById(targetProjectId);
  assertResourceInOrg(target, "Project", ctx.organizationId, targetProjectId);
  const source = await repos.project.findById(sourceProjectId);
  assertResourceInOrg(source, "Project", target.organizationId, sourceProjectId);
  if (source.deletionInProgress || target.deletionInProgress) {
    throw new ValidationError("A project in this connection is being deleted. Try again after deletion finishes.");
  }
  if (source.id === target.id) {
    throw new ValidationError("A project can't connect to itself.");
  }
  if (!opts?.refresh) ctx = await authorization.authorize(ctx, {
    resourceType: "project",
    resourceId: sourceProjectId,
    // Matches getAppConnection: connecting a source discloses its credentials.
    action: "write",
  });
  if (!opts?.refresh) ctx = await authorization.authorize(ctx, {
    resourceType: "project",
    resourceId: targetProjectId,
    action: "write",
  });

  // Resolve the connection value from the source app's already-computed outputs.
  const view = await getAppConnectionView(ctx, sourceProjectId);
  const output = view.outputs.find((o) => o.id === outputId)
    // Compatibility with the former alias-based synthesized output IDs.
    ?? view.outputs.find((o) => o.internal && (
      opts?.sourceServiceId ? o.sourceServiceId === opts.sourceServiceId : o.service === outputId
    ));
  if (!output || !output.value) {
    throw new ValidationError("That connection value isn't available yet on the source app.");
  }
  if (opts?.sourceServiceId && output.sourceServiceId !== opts.sourceServiceId) {
    throw new ValidationError("The source of this connection changed. Reconnect the service before deploying.");
  }
  let sourceServiceName: string | null = null;
  if (output.sourceServiceId) {
    const service = await repos.service.findById(output.sourceServiceId);
    if (!service || service.projectId !== source.id || service.enabled === false) {
      throw new ValidationError("The source service is no longer available.");
    }
    sourceServiceName = service.name;
  }

  // The source app template — used to default the reach mode from the endpoint's
  // declared scope and to rewrite the internal host.
  const template = await getTemplateForOrg(source.organizationId, source.appTemplateId ?? "");
  const spec = template
    ? getAppConnection(template)?.outputs.find((o) => o.id === outputId)
    : undefined;
  return { source, target, output, sourceServiceName, template, declaredPort: spec ? getOutputPort(spec) : null };
}

/**
 * WHICH MACHINE a project's workload sits on, collapsed so that every encoding of
 * "this box" compares equal.
 *
 * `box` covers all of them deliberately: a project with no server binding deploys to
 * the host docker socket, and so does the auto-registered isLocal "This Server" row
 * AND a plain loopback/SERVER_IP row for this host (deployment-runtime
 * `resolveTargetPlatform`, `isLocalHostRow`). One daemon means one set of
 * `openship-<slug>` networks, so treating those as different machines refuses pairs
 * that are demonstrably co-located.
 */
type ProjectHost = { kind: "cloud" } | { kind: "box" } | { kind: "server"; id: string };

const hostKey = (h: ProjectHost): string => (h.kind === "server" ? `server:${h.id}` : h.kind);

/**
 * Resolve which machine a project's workload sits on.
 *
 * Snapshot serverId FIRST, durable column second — the order `readDeployMeta` uses,
 * and for its reason: the snapshot is where the live release ACTUALLY runs while the
 * column is where the project is bound, and an alias only resolves next to the
 * running container. (`resolveSnapshotTarget` and `countActiveByServer` deliberately
 * invert this — they answer "where would the NEXT deploy go", a different question.)
 *
 * Cloud is the UNION of both signals, mirroring project-resources.service: the
 * `cloudWorkspaceId` column alone is not enough, because a self-hosted instance
 * orchestrating a cloud deploy deliberately leaves it null to stay local-canonical
 * (deployment-lifecycle, `isLocalOrchestratedCloud`) — for that shape the snapshot is
 * the only cloud signal there is, and reading the column alone declares it local.
 *
 * A project bound to nothing and never deployed is NOT unknown: `resolveSnapshotTarget`
 * resolves exactly that shape to the host default, so its first deploy lands on this
 * box and `box` is the honest answer. Reporting it as "no idea" instead read as
 * "nothing to refuse" at the call sites, which handed a remote source's alias to a
 * project that was about to deploy somewhere else entirely.
 */
async function resolveProjectHost(project: Project): Promise<ProjectHost> {
  const dep = project.activeDeploymentId
    ? await findActiveDeployment(project).catch(() => null)
    : null;
  const meta = (dep?.meta ?? null) as { deployTarget?: string; serverId?: string } | null;
  if (meta?.deployTarget === "cloud" || project.cloudWorkspaceId) return { kind: "cloud" };

  const serverId = meta?.serverId ?? project.serverId ?? null;
  if (!serverId) return { kind: "box" };

  const row = await repos.server
    .getInOrganization(serverId, project.organizationId)
    .catch(() => null);
  // A row we cannot read is not PROVABLY this box, so it stays its own machine — the
  // failure mode of guessing "local" here is a dead alias, which is what this check
  // exists to prevent.
  return row && (await isLocalHostRow(row).catch(() => false))
    ? { kind: "box" }
    : { kind: "server", id: serverId };
}

/** Also checked against the new deployment at network attachment, so moves cannot silently break a link. */
export async function privateConnectionError(source: Project, target: Project): Promise<string | null> {
  const [sourceHost, targetHost, targetDeployment] = await Promise.all([
    resolveProjectHost(source), resolveProjectHost(target),
    target.activeDeploymentId ? findActiveDeployment(target) : null,
  ]);
  if (sourceHost.kind === "cloud" || targetHost.kind === "cloud") return "Internal mode isn't available for a cloud-hosted app yet — use Public.";
  if (hostKey(sourceHost) !== hostKey(targetHost)) return "Internal mode needs both projects on the same server — they're on different servers.";
  const runtimeMode = (targetDeployment?.meta as { runtimeMode?: string } | null)?.runtimeMode ?? target.runtimeMode;
  if (runtimeMode === "bare") return "Private service connections require a Docker deployment for the consuming project.";
  return null;
}

/** The east-west value an internal connection should inject, or why it can't. */
type InternalResolution = { value: string } | { error: string };

/**
 * Resolve what INTERNAL mode would inject for this output, or the reason it isn't
 * viable. ONE resolver, because a caller that must choose a mode up front used to
 * infer availability from WHICH error `createConnection` happened to throw first —
 * so the answer depended on the shape of an unrelated output's value.
 */
async function resolveInternalValue(ends: ConnectionEnds): Promise<InternalResolution> {
  const { source, target, output, template, declaredPort } = ends;

  // GH-631: a non-URL value (password, token, API key, bucket name) names no host,
  // so internal mode has nothing to rewrite and nothing to reach — inject it
  // verbatim. Answered BEFORE reachability on purpose: a credential is equally
  // valid whichever box the source runs on, gating it on network topology would
  // re-break the case that was reported, and resolving hosts costs queries this
  // path has no use for.
  if (!isNetworkUrl(output.value)) return { value: output.value };

  // Everything below hands the consumer a HOST to reach east-west, which rides on
  // joining the source app's docker network at deploy (attachLinkedNetworks). Those
  // networks are per-machine and a failed attach only WARNS, so a link across two
  // machines injects an alias that resolves nowhere and still deploys green.
  const placementError = await privateConnectionError(source, target);
  if (placementError) return { error: placementError };

  // A synthesized output (plain app / raw compose, no template) already carries
  // the east-west address as its value — the synthesizer built it from the same
  // alias+port the container answers to on the shared network. Inject verbatim;
  // toInternalUrl would need a template and return null.
  if (output.internal) return { value: sharedInternalValue(output.value, output.sourceServiceId) };

  // Template source: rewrite host → the source app's internal service alias. The
  // output's declared/derived `service` and `port` are authoritative for which
  // alias+port to target; if it can't resolve, internal isn't viable here.
  const internal = toInternalUrl(output.value, template, output.service, declaredPort);
  return internal
    ? { value: sharedInternalValue(internal, output.sourceServiceId) }
    : {
        error:
          "Internal mode isn't available for this connection — use Public, or pick a database app's URL.",
      };
}

function sharedInternalValue(value: string, serviceId?: string): string {
  if (!serviceId) return value;
  const url = new URL(value);
  url.hostname = sharedServiceAlias(serviceId);
  return url.href;
}

/**
 * Would wiring `outputId` from `sourceProjectId` into `targetProjectId` as an
 * INTERNAL connection actually resolve? For a caller that has to commit to one
 * mode for a SET of outputs (the object-storage bind) and so must ask before it
 * writes. Answered by the same resolver `createConnection` runs, so the two can't
 * disagree. An unavailable internal is the answer here, not an error.
 */
export async function internalModeAvailable(
  ctx: RequestContext,
  targetProjectId: string,
  input: { sourceProjectId: string; outputId: string },
): Promise<boolean> {
  const ends = await loadConnectionEnds(
    ctx,
    targetProjectId,
    input.sourceProjectId,
    input.outputId,
  );
  return !("error" in (await resolveInternalValue(ends)));
}

async function prepareConnection(
  ctx: RequestContext,
  targetProjectId: string,
  input: CreateConnectionInput,
) {
  const envKey = input.envKey.trim();
  if (!isValidEnvKey(envKey)) {
    throw new ValidationError("Enter a valid environment variable name (letters, digits, _).");
  }

  const ends = await loadConnectionEnds(
    ctx,
    targetProjectId,
    input.sourceProjectId,
    input.outputId,
  );
  const { source, target, output, template } = ends;

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
    mode = output.internal || scope === "internal" ? "internal" : "public";
  }

  let value = output.value;
  if (mode === "public" && output.internal) {
    throw new ValidationError("This service has a private address. Connect it privately to a project on the same server.");
  }
  if (mode === "internal") {
    const resolved = await resolveInternalValue(ends);
    if ("error" in resolved) {
      // An EXPLICIT internal ask gets the reason. A DEFAULTED one falls back to
      // public — failing a request that never asked for internal turns a working
      // public wire-up into an error the caller can't act on.
      if (input.mode === "internal") throw new ValidationError(resolved.error);
      mode = "public";
    } else {
      value = resolved.value;
    }
  }
  if (mode === "public" && output.internal) {
    throw new ValidationError("Private service connections require both projects on the same Docker server.");
  }

  // Don't silently clobber a manually-set env var: if `envKey` already exists on
  // the target and isn't owned by an existing connection, refuse — disconnect
  // would later delete it, losing the user's own value. Re-connecting an
  // already-connection-owned key is fine (it's an upsert of our own var).
  const [existingVars, existingLinks] = await Promise.all([
    repos.project.listEnvVars(targetProjectId, ENVIRONMENT, null),
    repos.projectConnection.listByTarget(targetProjectId),
  ]);
  const connectionOwnedKeys = new Set(existingLinks.map((l) => l.envKey));
  const keyExisted = existingVars.some((v) => v.key === envKey);
  if (keyExisted && !connectionOwnedKeys.has(envKey)) {
    throw new ValidationError(
      `An environment variable "${envKey}" already exists on this project — remove it or choose a different key before connecting (a connection owns its key and removing the connection deletes it).`,
    );
  }

  const privateNetwork = mode === "internal" && isNetworkUrl(value);
  if (privateNetwork && output.sourceServiceId) {
    await ensureSharedServiceNetwork(source, output.sourceServiceId);
  }

  return {
    source,
    output,
    sourceServiceName: ends.sourceServiceName,
    binding: {
      encryptedValue: encrypt(value),
      connection: {
        organizationId: target.organizationId,
        sourceProjectId: source.id,
        sourceServiceId: output.sourceServiceId ?? null,
        targetProjectId: target.id,
        outputId: output.id,
        envKey,
        mode,
        usesPrivateNetwork: privateNetwork,
      },
    },
  };
}

export async function createConnection(
  ctx: RequestContext,
  targetProjectId: string,
  input: CreateConnectionInput,
  opts?: { defer?: boolean },
): Promise<{ connection: ConnectionView; requiresRedeploy: true }> {
  const connection = await withConnectionLocks(input.sourceProjectId, targetProjectId, async () => {
    const prepared = await prepareConnection(ctx, targetProjectId, input);
    const [row] = await repos.projectConnection.saveBindings(targetProjectId, ENVIRONMENT, [prepared.binding]);
    return toConnectionView(row, prepared.source, prepared.sourceServiceName);
  });
  if (!opts?.defer) await applyConnectionToTarget(ctx, targetProjectId);
  return { connection, requiresRedeploy: true };
}

export interface ConnectBundleItem {
  outputId: string;
  envKey: string;
}

/**
 * Wire a BUNDLE of outputs from one source app into a target project atomically:
 * either every item links, or none does. Preparation is shared with the single
 * connection path; env values and links are committed in one DB transaction.
 * Failed reconnects preserve existing bindings, and the consumer redeploys once.
 */
export async function connectBundle(
  ctx: RequestContext,
  targetProjectId: string,
  input: { sourceProjectId: string; items: ConnectBundleItem[]; mode?: ConnectionMode },
): Promise<{ connections: ConnectionView[]; requiresRedeploy: true }> {
  if (!input.items.length) throw new ValidationError("Choose at least one connection value.");
  const keys = input.items.map(item => item.envKey.trim());
  if (new Set(keys).size !== keys.length) throw new ValidationError("Choose a different environment variable name for each connection value.");
  const connections = await withConnectionLocks(input.sourceProjectId, targetProjectId, async () => {
    const prepared: Array<Awaited<ReturnType<typeof prepareConnection>>> = [];
    for (const item of input.items) prepared.push(await prepareConnection(ctx, targetProjectId, {
      sourceProjectId: input.sourceProjectId, ...item, mode: input.mode,
    }));
    const rows = await repos.projectConnection.saveBindings(targetProjectId, ENVIRONMENT, prepared.map(item => item.binding));
    return rows.map((row, index) => toConnectionView(row, prepared[index].source, prepared[index].sourceServiceName));
  });
  await applyConnectionToTarget(ctx, targetProjectId);
  return { connections, requiresRedeploy: true };
}

export async function deleteConnection(
  ctx: RequestContext,
  targetProjectId: string,
  linkId: string,
  /** `defer` skips the consumer redeployment. */
  opts?: { defer?: boolean },
): Promise<{ requiresRedeploy: true }> {
  ctx = await authorization.authorize(ctx, {
    resourceType: "project",
    resourceId: targetProjectId,
    action: "write",
  });
  const target = await repos.project.findById(targetProjectId);
  assertResourceInOrg(target, "Project", ctx.organizationId, targetProjectId);

  const existing = await repos.projectConnection.findInTarget(linkId, targetProjectId);
  if (!existing) throw new ValidationError("Connection not found.");

  await withConnectionLocks(existing.sourceProjectId, targetProjectId, async () => {
    const link = await repos.projectConnection.findInTarget(linkId, targetProjectId);
    if (!link || link.sourceProjectId !== existing.sourceProjectId) throw new ValidationError("This connection changed. Refresh the project before disconnecting.");
    if (usesPrivateNetwork(link) && link.sourceServiceId) {
      const source = await repos.project.findById(link.sourceProjectId);
      assertResourceInOrg(source, "Project", target.organizationId, link.sourceProjectId);
      await disconnectSharedServiceNetwork(source, target, link.sourceServiceId, link.id);
    }

    await mergeEnvVars(targetProjectId, target.organizationId, {
      environment: ENVIRONMENT, upserts: [], deletes: [link.envKey],
    });
    await repos.projectConnection.delete(linkId);
  });
  // Refresh the running consumer so the removed env leaves the live container.
  if (!opts?.defer) await applyConnectionToTarget(ctx, targetProjectId);
  return { requiresRedeploy: true };
}

/** Refresh references before a normal deploy freezes its env; rollback keeps its snapshot. */
export async function refreshConnectionEnv(
  ctx: RequestContext,
  targetProjectId: string,
  environment: string,
): Promise<Record<string, string>> {
  if (environment !== ENVIRONMENT) return {};
  const links = (await repos.projectConnection.listByTarget(targetProjectId))
    .filter(link => !!link.sourceServiceId);
  if (!links.length) return {};
  const resolved: Record<string, string> = {};
  const rows = await repos.project.listEnvVars(targetProjectId, environment, null);
  const values = new Map(rows.map(row => [row.key, decrypt(row.value)]));
  const upserts: Array<{ key: string; value: string; isSecret: boolean }> = [];
  for (const link of links) {
    const ends = await loadConnectionEnds(ctx, targetProjectId, link.sourceProjectId, link.outputId, {
      refresh: true, sourceServiceId: link.sourceServiceId,
    });
    let value = ends.output.value;
    if (link.mode === "internal") {
      const result = await resolveInternalValue(ends);
      if ("error" in result) throw new ValidationError(result.error);
      value = result.value;
    }
    resolved[link.envKey] = value;
    if (values.get(link.envKey) !== value) upserts.push({ key: link.envKey, value, isSecret: true });
  }
  if (upserts.length) await mergeEnvVars(targetProjectId, ctx.organizationId, { environment, upserts, deletes: [] });
  return resolved;
}

/**
 * Unlink a SOURCE app from every project it was wired into, because that app is
 * being deleted. Removes each injected env var and drops the link row.
 *
 * Deliberately NOT `deleteConnection` in a loop:
 *
 *   • No permission assert on the consumers. This isn't a user editing another
 *     project's env — it's the unavoidable consequence of deleting the app they
 *     already have admin on (`sourceProjectId` is ON DELETE RESTRICT, so the link
 *     cannot outlive it). Requiring write on every consumer would make a
 *     narrowly-scoped token unable to delete its own app.
 *   • No redeploy of the consumer. The app is going away, so redeploying would
 *     boot it WITHOUT the env var (likely crash-looping) instead of leaving the
 *     running container alone with a now-dead URL. Callers report who to redeploy.
 *
 * Best-effort per link: a failure is collected, not thrown, so one stuck consumer
 * doesn't hide the rest. Teardown keeps the project row when `errors` is
 * non-empty — the FK would refuse the drop anyway.
 */
export async function unlinkConsumersOfSource(
  links: Array<{ id: string; targetProjectId: string; envKey: string }>,
): Promise<{
  unlinked: Array<{ linkId: string; projectId: string; projectName: string; envKey: string }>;
  errors: string[];
}> {
  const unlinked: Array<{
    linkId: string;
    projectId: string;
    projectName: string;
    envKey: string;
  }> = [];
  const errors: string[] = [];

  for (const link of links) {
    const target = await repos.project.findById(link.targetProjectId).catch(() => null);
    const name = target?.name ?? link.targetProjectId;
    try {
      // A target that's already gone leaves nothing to clean up — its own delete
      // cascaded the link away (target FK is ON DELETE CASCADE).
      if (target) {
        await mergeEnvVars(link.targetProjectId, target.organizationId, {
          environment: ENVIRONMENT,
          upserts: [],
          deletes: [link.envKey],
        });
      }
      await repos.projectConnection.delete(link.id);
      unlinked.push({
        linkId: link.id,
        projectId: link.targetProjectId,
        projectName: name,
        envKey: link.envKey,
      });
    } catch (err) {
      errors.push(
        `${link.envKey} on ${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { unlinked, errors };
}
