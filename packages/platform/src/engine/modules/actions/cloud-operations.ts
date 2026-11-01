import { AppError, CLOUD_UNREACHABLE_CODE, safeErrorMessage } from "@repo/core";
import { diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import {
  ActionCollectionRoutes,
  ActionCollectionSchemas,
  ActionResourceRoutes,
  ActionResourceSchemas,
  isRecord,
  isResourceOutput,
  type ResourceOperationSchema,
} from "@repo/contracts";
import type { ActionDependencies } from "../../../actions";
import type { ExecutionContext } from "../../../context";
import { env } from "../../config/index";
import {
  canDiscoverCloudResources,
  resolveResourceAuthority,
  type ConnectedResourceType,
} from "../../lib/cloud/resource-authority";
import { assertCloudProxyScope } from "../../lib/cloud/scope";
import { cloudRequestReferences } from "../../lib/cloud/server-reference";
import { cloudRequestError } from "../../lib/cloud/request-error";
import {
  cloudFetchAsOrgOwner,
  readCloudJson,
  resolveOrgCloudUserId,
} from "../../lib/cloud/transport";

type Collection = keyof typeof ActionCollectionSchemas;
type Resource = keyof typeof ActionResourceSchemas;
type Reference = { type: ConnectedResourceType; id: string };

function workflowReferences(input: Record<string, unknown>): Reference[] {
  return [
    ...references("project", input.projectIds),
    ...references("actionRunner", input.runnerIds),
  ];
}
function references(type: ConnectedResourceType, ids: unknown): Reference[] {
  return (Array.isArray(ids) ? ids : [ids])
    .filter((id): id is string => typeof id === "string" && !!id)
    .map((id) => ({ type, id }));
}
function collectionReferences(name: Collection, input: Record<string, unknown>): Reference[] {
  switch (name) {
    case "list":
    case "projectPolicy":
    case "updateDeploymentRequest":
      return references("project", input.projectId);
    case "listRuns":
      return [
        ...references("project", input.projectId),
        ...references("actionWorkflow", input.workflowId),
      ];
    case "updateProjectPolicy":
      return [
        ...references("project", input.projectId),
        ...references("actionWorkflow", input.workflowIds),
        ...references("actionWorkflow", input.requiredWorkflowIds),
      ];
    case "create":
      return workflowReferences(input);
    case "importWorkflows":
      return (input.workflows as Record<string, unknown>[]).flatMap(workflowReferences);
    case "addRunner":
    case "inspectDestination":
    case "enableEmulation":
      return references("server", input.serverId);
    default:
      // Repository credentials and YAML previews belong to the current instance.
      return [];
  }
}
const resourceTypes: Record<Resource, ConnectedResourceType> = {
  get: "actionWorkflow",
  update: "actionWorkflow",
  remove: "actionWorkflow",
  dispatch: "actionWorkflow",
  getRun: "actionRun",
  artifacts: "actionRun",
  artifactDownload: "actionRun",
  cancel: "actionRun",
  approve: "actionRun",
  rerun: "actionRun",
  updateRunner: "actionRunner",
  removeRunner: "actionRunner",
  probeRunner: "actionRunner",
  jobEvents: "actionJob",
};

/** Resolve every target before mutation; one import/policy cannot span databases. */
async function authority(ctx: ExecutionContext, refs: Reference[]): Promise<"local" | "cloud"> {
  const unique = [...new Map(refs.map((ref) => [`${ref.type}:${ref.id}`, ref])).values()];
  const authorities = await Promise.all(
    unique.map((ref) => resolveResourceAuthority(ref.type, ref.id, ctx.organizationId)),
  );
  if (!authorities.includes("cloud")) return "local";
  assertCloudProxyScope(ctx);
  if (authorities.some((value) => value !== "cloud"))
    throw new AppError(
      "Choose projects, workflows and runners from the same Openship instance. Cloud Actions cannot use local destinations.",
      409,
      "ACTIONS_MIXED_AUTHORITY",
    );
  return "cloud";
}

async function remote(
  ctx: ExecutionContext,
  route: { method: string; path(id: string): string; envelope?: string },
  spec: ResourceOperationSchema,
  input: unknown,
  id = "*",
): Promise<unknown> {
  assertCloudProxyScope(ctx);
  const url = new URL(`/api${route.path(id)}`, "http://openship.internal");
  const payload = isRecord(input) ? await cloudRequestReferences(ctx.organizationId, input) : input;
  if (route.method === "GET" && isRecord(payload))
    for (const [key, value] of Object.entries(payload))
      if (value !== undefined) url.searchParams.set(key, String(value));
  const response = await cloudFetchAsOrgOwner(ctx.organizationId, `${url.pathname}${url.search}`, {
    method: route.method,
    ...(route.method !== "GET" && payload !== undefined && { body: JSON.stringify(payload) }),
  });
  if (!response)
    throw new AppError(
      "Could not reach Openship Cloud. Check your connection and try again.",
      503,
      CLOUD_UNREACHABLE_CODE,
    );
  if (!response.ok) {
    const error = await cloudRequestError(response, "Cloud Actions");
    throw new AppError(error.message, error.status, error.code);
  }
  const body = await readCloudJson<unknown>(response);
  const data = route.envelope && isRecord(body) ? body[route.envelope] : body;
  if (!isResourceOutput(spec, data))
    throw new AppError(
      "Openship Cloud returned an invalid Actions response",
      502,
      "INVALID_OPERATION_RESPONSE",
    );
  return data;
}

/** Epoch ms for a run's `createdAt`, which is a `Date` for local rows (Drizzle
 * `timestamp`) and an ISO string for Cloud rows. Absent or unparseable → 0, i.e.
 * ordered after any real (post-epoch) run timestamp in the newest-first sort. */
function runCreatedAtMillis(value: Date | string | number | null | undefined): number {
  if (value == null) return 0;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/** Runs after the shared validation and job permission gate. Cloud remains the
 * authority for its repositories, destinations, policies, approval and audit.
 * No worker endpoints, credentials or local records are copied to Cloud. */
export function withCloudActions(local: ActionDependencies): ActionDependencies {
  const collection = Object.fromEntries(
    Object.entries(ActionCollectionSchemas).map(([key, spec]) => {
      const name = key as Collection;
      return [
        name,
        async (ctx: ExecutionContext, input?: unknown) => {
          const call = local.collection[name] as (
            ctx: ExecutionContext,
            input?: unknown,
          ) => Promise<unknown>;
          if (env.CLOUD_MODE) return call(ctx, input);
          const refs = collectionReferences(name, isRecord(input) ? input : {});
          if ((await authority(ctx, refs)) === "cloud")
            return remote(ctx, ActionCollectionRoutes[name], spec, input);
          const data = await call(ctx, input);
          if (
            refs.length ||
            !["list", "listRuns", "runners", "projects"].includes(name) ||
            !canDiscoverCloudResources(ctx) ||
            !(await resolveOrgCloudUserId(ctx.organizationId))
          )
            return data;
          // Cloud being offline must not hide this instance's own Actions.
          const cloud = await (
            remote(ctx, ActionCollectionRoutes[name], spec, input) as Promise<
              { id: string; createdAt?: Date | string }[]
            >
          ).catch((error) => {
            errorDiagnostics.warn(
              "platform/engine/modules/actions/cloud-operations",
              `[cloud-actions] Could not list Cloud ${name}:`,
              safeErrorMessage(error),
              error,
            );
            return null;
          });
          if (!cloud) return data;
          // Merging/sorting the Cloud result must likewise never hide local Actions.
          try {
            const merged = [
              ...new Map([...cloud, ...(data as typeof cloud)].map((row) => [row.id, row])).values(),
            ];
            if (name !== "listRuns") return merged;
            return merged
              .sort((a, b) => runCreatedAtMillis(b.createdAt) - runCreatedAtMillis(a.createdAt))
              .slice(0, isRecord(input) && typeof input.limit === "number" ? input.limit : 30);
          } catch (error) {
            errorDiagnostics.warn(
              "platform/engine/modules/actions/cloud-operations",
              `[cloud-actions] Could not merge Cloud ${name}; returning local results only:`,
              safeErrorMessage(error),
              error,
            );
            return data;
          }
        },
      ];
    }),
  ) as ActionDependencies["collection"];
  const resources = Object.fromEntries(
    Object.entries(ActionResourceSchemas).map(([key, spec]) => {
      const name = key as Resource;
      return [
        name,
        async (ctx: ExecutionContext, id: string, input?: unknown) => {
          const call = local.resources[name] as (
            ctx: ExecutionContext,
            id: string,
            input?: unknown,
          ) => Promise<unknown>;
          if (env.CLOUD_MODE) return call(ctx, id, input);
          const refs = [
            { type: resourceTypes[name], id },
            ...(name === "update" && isRecord(input) ? workflowReferences(input) : []),
            ...(name === "updateRunner" && isRecord(input)
              ? references("server", input.serverId)
              : []),
          ];
          return (await authority(ctx, refs)) === "cloud"
            ? remote(ctx, ActionResourceRoutes[name], spec, input, id)
            : call(ctx, id, input);
        },
      ];
    }),
  ) as ActionDependencies["resources"];
  return { collection, resources };
}
