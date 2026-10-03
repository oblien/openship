import { DockerRuntime, splitRuntimeEnv } from "@repo/adapters";
import {
  AppError,
  ENV_MASK,
  isValidEnvKey,
  looksLikeSecretKey,
  safeErrorMessage,
  type Environment,
} from "@repo/core";
import type {
  MergeServiceEnvVarsInput,
  ServiceEnvironment,
  ServiceEnvironmentInput,
} from "@repo/contracts";
import { parseOptionalEnvironmentScope } from "@repo/contracts";
import { repos } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import { findActiveDeployment } from "../../lib/active-deployment";
import { disposeRuntime, resolveDeploymentRuntimeForRead } from "../../lib/deployment-runtime";
import { decryptEnvMap, encrypt } from "../../lib/encryption";
import { withProjectRuntimeLock } from "../../lib/project-runtime-lock";
import { mergeServiceDeployEnv } from "../deployments/compose/service-env-layers";
import {
  buildServicePublicUrlMap,
  resolveEnvPublicUrls,
  resolvePortOnlyEnvHost,
} from "../deployments/compose/deploy.service";
import { toDiscoveredService } from "../migration/docker-reconcile";
import { assertServiceAccess } from "./service-access";
import { containerIdForService, liveContainerIdWithRuntime } from "./service-container";

const decryptMap = (values: Record<string, string>) =>
  decryptEnvMap(values, (key) => {
    throw new AppError(
      `Could not read saved environment variable "${key}".`,
      500,
      "ENVIRONMENT_DECRYPT_FAILED",
    );
  });

/** Read the control plane independently of Docker. The same layers feed deploy and Apply. */
export async function loadServiceEnvironment(
  ctx: ExecutionContext,
  projectId: string,
  serviceId: string,
  environment?: Environment,
) {
  const { project, svc: service } = await assertServiceAccess(ctx, projectId, serviceId);
  const deployment = await findActiveDeployment(project);
  const scope =
    parseOptionalEnvironmentScope(environment ?? deployment?.environment) ?? "production";
  const [projectRows, serviceRows] = await Promise.all([
    repos.project.listEnvVars(projectId, scope, null),
    repos.project.listEnvVars(projectId, scope, serviceId),
  ]);
  const projectEnv = decryptMap(Object.fromEntries(projectRows.map((row) => [row.key, row.value])));
  const serviceEnv = decryptMap(Object.fromEntries(serviceRows.map((row) => [row.key, row.value])));
  const merged = mergeServiceDeployEnv(
    {
      project: projectEnv,
      frozen: {},
      inline: service.environment ?? {},
      templateKeys: service.advanced?.environmentTemplateKeys,
      service: serviceEnv,
    },
    false,
  );
  const port = Number(service.exposedPort);
  if (merged.env.PORT === undefined && Number.isInteger(port) && port > 0 && port <= 65535) {
    merged.env.PORT = String(port);
  }
  return { project, service, deployment, scope, projectRows, serviceRows, merged };
}

type SavedEnvironment = Awaited<ReturnType<typeof loadServiceEnvironment>>;

/** Resolve target-dependent tokens once for both the runtime comparison and Apply. */
export async function resolveServiceRuntimeEnvironment(
  ctx: ExecutionContext,
  saved: SavedEnvironment,
  target: { serverId?: string | null; cloudRuntime?: boolean },
) {
  if (saved.merged.missingRequired.length > 0) {
    throw new AppError(
      `Required environment variables are missing: ${saved.merged.missingRequired.map((item) => item.variable).join(", ")}`,
      400,
      "ENVIRONMENT_REQUIRED",
    );
  }
  let environment = saved.merged.env;
  if (Object.values(environment).some((value) => value.includes("{{publicUrl:"))) {
    const services = await repos.service.listByProject(saved.project.id);
    const { host } = await resolvePortOnlyEnvHost(ctx.organizationId, {
      serverId: target.serverId ?? undefined,
      cloudRuntime: target.cloudRuntime,
    });
    const urls = buildServicePublicUrlMap(saved.project, services, host);
    const resolved = resolveEnvPublicUrls(environment, (name, port) =>
      urls.get(port === undefined ? name : `${name}:${port}`),
    );
    if (resolved.unresolved.length > 0) {
      throw new AppError(
        `Public URLs are missing for environment variables: ${resolved.unresolved.map((item) => item.key).join(", ")}`,
        409,
        "ENVIRONMENT_URL_UNRESOLVED",
      );
    }
    environment = resolved.env;
  }
  return Object.fromEntries(splitRuntimeEnv(environment).entries);
}

function savedView(saved: SavedEnvironment): ServiceEnvironment {
  const overrides = new Map(saved.serviceRows.map((row) => [row.key, row]));
  const projectVars = new Map(saved.projectRows.map((row) => [row.key, row]));
  const missingRequired = saved.merged.missingRequired.map((item) => item.variable);
  const values = { ...saved.merged.env };
  for (const key of missingRequired) if (!Object.hasOwn(values, key)) values[key] = "";
  const variables: ServiceEnvironment["variables"] = Object.entries(values).map(([key, value]) => {
    const override = overrides.get(key);
    const fromCompose =
      Object.hasOwn(saved.service.environment ?? {}, key) &&
      !saved.merged.deferredEmpty.includes(key);
    const source = override
      ? "service"
      : fromCompose
        ? "compose"
        : projectVars.has(key)
          ? "project"
          : "generated";
    // Compose's literals AND interpolations may contain secrets. Never infer
    // their sensitivity from the name or expose a project secret through one.
    const isSecret =
      override?.isSecret ??
      (fromCompose ? true : (projectVars.get(key)?.isSecret ?? looksLikeSecretKey(key)));
    return {
      key,
      value: isSecret && value !== "" ? ENV_MASK : value,
      isSecret,
      source,
      ...(override ? { sourceId: override.id } : {}),
      ...(missingRequired.includes(key) ? { missing: true } : {}),
    };
  });
  return {
    environment: saved.scope,
    variables,
    missingRequired,
    status: "unchecked",
    changedKeys: [],
    recoverableKeys: [],
  };
}

function envEntries(values: string[]): Record<string, string> {
  return Object.fromEntries(
    values.flatMap((entry) => {
      const at = entry.indexOf("=");
      return at > 0 ? [[entry.slice(0, at), entry.slice(at + 1)]] : [];
    }),
  );
}

/** Read ONLY the live container that belongs to this service on its deployment target. */
async function inspectServiceEnvironment(saved: SavedEnvironment) {
  if (!saved.deployment || saved.deployment.environment !== saved.scope) {
    throw new AppError(
      "Deploy this environment before comparing it with the running service.",
      409,
      "SERVICE_NOT_DEPLOYED",
    );
  }
  const { runtime, serverId } = await resolveDeploymentRuntimeForRead({ ...saved.deployment, meta: { ...(saved.deployment.meta as Record<string, unknown>), runtimeMode: "docker" } });
  try {
    if (!(runtime instanceof DockerRuntime)) {
      throw new AppError(
        "Use Redeploy to apply environment changes on this runtime.",
        409,
        "SERVICE_ENVIRONMENT_UNSUPPORTED",
      );
    }
    const tracked = await containerIdForService(saved.deployment, saved.service);
    const containerId = await liveContainerIdWithRuntime(runtime, {
      service: saved.service,
      projectId: saved.project.id,
      slug: saved.project.slug,
      tracked,
    });
    const detail = containerId ? await runtime.inspectContainer(containerId) : null;
    if (!detail)
      throw new AppError(
        "This service has no container. Use Redeploy first.",
        409,
        "SERVICE_NOT_DEPLOYED",
      );
    if (
      (detail.labels["openship.project"] &&
        detail.labels["openship.project"] !== saved.project.id) ||
      (detail.labels["openship.service"] &&
        detail.labels["openship.service"] !== saved.service.name)
    )
      throw new AppError(
        "The running container does not belong to this service.",
        409,
        "SERVICE_ENVIRONMENT_UNAVAILABLE",
      );
    if (!detail.imageId)
      throw new AppError(
        "The running service's image could not be identified.",
        409,
        "SERVICE_ENVIRONMENT_UNAVAILABLE",
      );
    const imageEnv = await runtime.inspectImageEnv(detail.imageId, { required: true });
    return {
      containerId: detail.id,
      current: envEntries(detail.env),
      image: envEntries(imageEnv),
      // Use migration's provenance rules; image defaults are not recovered as overrides.
      recoverable: toDiscoveredService(detail, undefined, imageEnv).env,
      serverId,
      cloudRuntime: !!saved.project.workspaceId,
    };
  } finally {
    disposeRuntime(runtime);
  }
}

export async function getServiceEnvironment(
  ctx: ExecutionContext,
  projectId: string,
  serviceId: string,
  input: ServiceEnvironmentInput = {},
): Promise<ServiceEnvironment> {
  const saved = await loadServiceEnvironment(ctx, projectId, serviceId, input.environment);
  const view = savedView(saved);
  if (!input.inspectRuntime) return view;
  try {
    const live = await inspectServiceEnvironment(saved);
    view.containerId = live.containerId;
    view.recoverableKeys = Object.keys(live.recoverable ?? {})
      .filter((key) => !Object.hasOwn(saved.merged.env, key))
      .sort();
    const desired = await resolveServiceRuntimeEnvironment(ctx, saved, {
      serverId: live.serverId,
      cloudRuntime: live.cloudRuntime,
    });
    const expected = { ...live.image, ...desired };
    view.changedKeys = [...new Set([...Object.keys(expected), ...Object.keys(live.current)])]
      .filter((key) => expected[key] !== live.current[key])
      .sort();
    view.status = view.changedKeys.length ? "pending" : "synced";
  } catch (error) {
    view.status =
      error instanceof AppError && error.code === "SERVICE_NOT_DEPLOYED"
        ? "not-deployed"
        : error instanceof AppError && error.code === "SERVICE_ENVIRONMENT_UNSUPPORTED"
          ? "unsupported"
          : "unavailable";
    view.message = safeErrorMessage(error);
  }
  return view;
}

export async function revealEffectiveServiceEnvironment(
  ctx: ExecutionContext,
  projectId: string,
  serviceId: string,
  input: { environment?: Environment; source: "effective" | "runtime"; containerId?: string },
) {
  const saved = await loadServiceEnvironment(ctx, projectId, serviceId, input.environment);
  if (input.source === "effective") return saved.merged.env;
  if (!input.containerId)
    throw new AppError(
      "Check the running service before recovering its environment.",
      409,
      "ENVIRONMENT_RUNTIME_CHANGED",
    );
  const live = await inspectServiceEnvironment(saved);
  if (live.containerId !== input.containerId)
    throw new AppError(
      "The running service changed. Check its environment again before recovering values.",
      409,
      "ENVIRONMENT_RUNTIME_CHANGED",
    );
  // Recovery cannot replace a saved control-plane key, including an explicit empty value.
  return Object.fromEntries(
    Object.entries(live.recoverable ?? {}).filter(([key]) => !Object.hasOwn(saved.merged.env, key)),
  );
}

export async function mergeServiceEnvVars(
  ctx: ExecutionContext,
  projectId: string,
  serviceId: string,
  input: MergeServiceEnvVarsInput,
) {
  return withProjectRuntimeLock(projectId, async () => {
    const saved = await loadServiceEnvironment(ctx, projectId, serviceId, input.environment);
    if (saved.project.deletionInProgress)
      throw new AppError("This project is being deleted.", 409, "PROJECT_DELETING");
    const byId = new Map(saved.serviceRows.map((row) => [row.id, row]));
    const byKey = new Map(saved.serviceRows.map((row) => [row.key, row]));
    const inheritedSecrets = new Map(
      savedView(saved).variables.map((row) => [row.key, row.isSecret]),
    );
    const stale = () => {
      throw new AppError(
        "These environment variables changed since you opened the editor. Reload before saving; your edits have not been applied.",
        409,
        "ENVIRONMENT_CHANGED",
      );
    };
    const deletes = new Set<string>();
    for (const row of input.deletes) {
      if (byId.get(row.sourceId)?.key !== row.key) stale();
      deletes.add(row.key);
    }
    const keys = new Set<string>();
    const sources = new Set<string>();
    const upserts = input.upserts.map((row) => {
      if (!isValidEnvKey(row.key) || row.value.includes("\0"))
        throw new AppError(
          `Invalid environment variable "${row.key}".`,
          400,
          "INVALID_ENVIRONMENT",
        );
      if (keys.has(row.key))
        throw new AppError(
          `Duplicate environment variable "${row.key}".`,
          400,
          "INVALID_ENVIRONMENT",
        );
      keys.add(row.key);
      const prior = row.sourceId ? byId.get(row.sourceId) : undefined;
      if (row.sourceId && (!prior || sources.has(row.sourceId))) stale();
      if (row.sourceId) sources.add(row.sourceId);
      const target = byKey.get(row.key);
      if (target && target.id !== prior?.id) stale();
      if (prior && prior.key !== row.key) deletes.add(prior.key);
      const value = row.value === ENV_MASK ? (prior ? null : saved.merged.env[row.key]) : row.value;
      if (value === undefined || value === ENV_MASK)
        throw new AppError(
          `No saved value exists for "${row.key}". Enter its value before saving.`,
          400,
          "ENVIRONMENT_VALUE_REQUIRED",
        );
      return {
        key: row.key,
        value: value === null ? prior!.value : encrypt(value),
        isSecret:
          row.isSecret ??
          prior?.isSecret ??
          inheritedSecrets.get(row.key) ??
          looksLikeSecretKey(row.key),
      };
    });
    const remainingKeys = new Set(
      saved.serviceRows.map((row) => row.key).filter((key) => !deletes.has(key)),
    );
    for (const row of upserts) remainingKeys.add(row.key);
    if (remainingKeys.size > 100)
      throw new AppError(
        "A service can have at most 100 environment overrides.",
        400,
        "ENVIRONMENT_LIMIT",
      );
    await repos.project.mergeEnvVars(
      projectId,
      input.environment,
      upserts,
      [...deletes],
      serviceId,
    );
    return { success: true as const };
  });
}
