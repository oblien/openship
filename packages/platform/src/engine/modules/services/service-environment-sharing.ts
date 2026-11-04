import { createHmac } from "node:crypto";
import { AppError, ENV_MASK, mergeServiceDeployEnv, resolveComposeValue } from "@repo/core";
import type { MergeServiceEnvVarsInput, ServiceEnvironmentReview } from "@repo/contracts";
import { repos } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import { env } from "../../config/env";
import { authorization } from "../../lib/authorization";
import { decrypt } from "../../lib/encryption";
import { assertServiceAccess } from "./service-access";

type Snapshot = Awaited<ReturnType<typeof repos.project.environmentSnapshot>>;
type Edit = Omit<MergeServiceEnvVarsInput, "shared">;

/** Keyed, scoped and value-safe: a review token must not be a password oracle. */
export function environmentReviewRevision(
  projectId: string,
  serviceId: string,
  input: Edit,
  snapshot: Snapshot,
) {
  const canonical = JSON.stringify(
    {
      projectId,
      serviceId,
      environment: input.environment,
      upserts: input.upserts,
      deletes: input.deletes,
      vars: [...snapshot.vars].sort((a, b) => a.id.localeCompare(b.id)),
      services: snapshot.services
        .map(({ id, name, enabled, environment, advanced }) => ({
          id,
          name,
          enabled,
          environment,
          templateKeys: advanced?.environmentTemplateKeys,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    },
    (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
        : value,
  );
  return createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update("openship-shared-environment-v1\0")
    .update(canonical)
    .digest("hex");
}

export function sharedEnvironmentChanged(): never {
  throw new AppError(
    "Shared configuration changed. Review your changes again before saving.",
    409,
    "ENVIRONMENT_CHANGED",
  );
}

/** Only genuine inheritance is editable as a shared source. Equal literals,
 * service overrides and already-expanded legacy imports never imply a link. */
export async function reviewSharedServiceEnvironment(
  ctx: ExecutionContext,
  projectId: string,
  serviceId: string,
  input: Edit,
): Promise<{ review: ServiceEnvironmentReview; snapshot: Snapshot | null }> {
  await assertServiceAccess(ctx, projectId, serviceId);
  if (
    !(await authorization.checkPermissionOnResource(ctx, {
      resourceType: "project",
      resourceId: projectId,
      action: "write",
    }))
  )
    return { review: { revision: "0".repeat(64), changes: [] }, snapshot: null };

  const snapshot = await repos.project.environmentSnapshot(projectId, input.environment);
  const current = snapshot.services.find((service) => service.id === serviceId);
  if (!current) sharedEnvironmentChanged();
  const projectRows = snapshot.vars.filter((row) => !row.serviceId);
  const project = Object.fromEntries(projectRows.map((row) => [row.key, decrypt(row.value)]));
  const layers = snapshot.services.map((service) => ({
    service,
    overrides: Object.fromEntries(
      snapshot.vars
        .filter((row) => row.serviceId === service.id)
        .map((row) => [row.key, decrypt(row.value)]),
    ),
  }));
  const resolve = (entry: (typeof layers)[number], values = project) =>
    mergeServiceDeployEnv(
      {
        project: values,
        frozen: {},
        inline: entry.service.environment ?? {},
        templateKeys: entry.service.advanced?.environmentTemplateKeys,
        service: entry.overrides,
      },
      false,
    );
  const own = layers.find((entry) => entry.service.id === serviceId)!;
  const before = resolve(own);
  const templates = new Set(current.advanced?.environmentTemplateKeys ?? []);
  const directSource = (key: string, seen = new Set<string>()): string | undefined => {
    if (seen.has(key) || Object.hasOwn(own.overrides, key)) return;
    seen.add(key);
    const inline = current.environment ?? {};
    if (Object.hasOwn(inline, key) && !before.deferredEmpty.includes(key)) {
      if (!templates.has(key)) return;
      const expression = inline[key]!;
      const scope = { ...before.env };
      if (Object.hasOwn(project, key)) scope[key] = project[key]!;
      else delete scope[key];
      // The Compose resolver labels only a direct lookup as env-file.
      // Embedded strings, fallbacks and conditional replacements aren't
      // invertible shared sources; don't introduce a second expression parser.
      const { meta } = resolveComposeValue(expression, scope);
      if (meta?.source !== "env-file" || !meta.variable) return;
      if (meta.variable !== key) return directSource(meta.variable, seen);
    }
    return Object.hasOwn(project, key) ? key : undefined;
  };

  const changes: ServiceEnvironmentReview["changes"] = [];
  const baselines = new Map(layers.map((entry) => [entry.service.id, resolve(entry).env]));
  for (const edit of input.upserts) {
    if (edit.sourceId || edit.value === ENV_MASK || edit.value === before.env[edit.key]) continue;
    const projectKey = directSource(edit.key);
    if (!projectKey) continue;
    const next = { ...project, [projectKey]: edit.value };
    // For example, an empty source with `:-default` cannot produce an empty
    // target. Keep that edit local instead of silently saving a different value.
    if (resolve(own, next).env[edit.key] !== edit.value) continue;
    const services: ServiceEnvironmentReview["changes"][number]["services"] = [];
    for (const entry of layers) {
      const oldValues = baselines.get(entry.service.id)!;
      const newValues = resolve(entry, next).env;
      const keys = Object.keys(newValues)
        .filter((key) => oldValues[key] !== newValues[key])
        .sort();
      if (!keys.length) continue;
      // Service permissions inherit this project's grant, checked above. The
      // snapshot contains only children of that authorized project.
      services.push({ id: entry.service.id, name: entry.service.name, keys });
    }
    if (services.length) changes.push({ key: edit.key, projectKey, services });
  }
  return {
    review: { revision: environmentReviewRevision(projectId, serviceId, input, snapshot), changes },
    snapshot,
  };
}
