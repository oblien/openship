import { AppError, NotFoundError, actionFinished } from "@repo/core";
import { diagnostics } from "@repo/core/diagnostics";
import { resolveDestination } from "@repo/adapters";
import { repos, type ActionJob, type ActionRun } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import { env } from "../../config/env";
import { authorization } from "../../lib/authorization";
import {
  captureExecutionAuthority,
  resolveExecutionAuthority,
} from "../../lib/execution-authority";
import { toAdapterRow } from "../backup-destinations/hydrate-server";
import { authorizeActionRun } from "./access";
import { ActionRuntimeTokens, type ActionRuntimeIdentity } from "./runtime-identity";
import { ActionStorageProtocol } from "./storage-protocol";

/** A configured origin, never an incoming Host header. Desktop users can run
 * jobs without storage; artifacts require a published, reachable controller. */
export function actionRuntimeUrl(): string {
  const value = process.env.OPENSHIP_ACTIONS_RUNTIME_URL?.trim() || env.OPENSHIP_PUBLIC_URL;
  if (!value)
    throw new AppError(
      "Publish this instance and configure its public URL to use workflow artifacts and caches",
      409,
      "ACTIONS_RUNTIME_URL_REQUIRED",
    );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError("The Actions runtime URL is invalid", 503, "ACTIONS_RUNTIME_URL_INVALID");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new AppError(
      "The Actions runtime URL must be an HTTPS origin reachable from your runners",
      503,
      "ACTIONS_RUNTIME_URL_INVALID",
    );
  return `${url.origin}/api/actions/runtime/`;
}

export async function actionStorageDestination(organizationId: string, id: string) {
  const row = await repos.backupDestination.findById(id);
  if (!row || row.organizationId !== organizationId)
    throw new NotFoundError("Actions storage destination", id);
  if (env.CLOUD_MODE && row.kind === "local")
    throw new AppError(
      "Cloud Actions requires an S3-compatible storage destination",
      409,
      "ACTIONS_STORAGE_UNSUPPORTED",
    );
  if (!["local", "s3_compatible"].includes(row.kind))
    throw new AppError(
      "Actions storage requires an S3-compatible or local storage destination",
      409,
      "ACTIONS_STORAGE_UNSUPPORTED",
    );
  const store = resolveDestination(await toAdapterRow(row));
  if (!store.capabilities.has("rangedGet"))
    throw new AppError(
      "This storage destination does not support ranged downloads",
      409,
      "ACTIONS_STORAGE_UNSUPPORTED",
    );
  return store;
}

export async function authorizeActionStorage(
  ctx: ExecutionContext,
  id: string,
  write = false,
): Promise<void> {
  await authorization.authorize(
    { ...ctx, scopeMode: "fixed" },
    { resourceType: "backup_destination", resourceId: id, action: write ? "write" : "read" },
  );
  await actionStorageDestination(ctx.organizationId, id);
}

let tokens: ActionRuntimeTokens | undefined;
const runtimeTokens = () => (tokens ??= new ActionRuntimeTokens(env.BETTER_AUTH_SECRET));

export async function actionRuntimeEnvironment(
  run: ActionRun,
  job: ActionJob,
): Promise<Record<string, string>> {
  if (!run.configuration.storageDestinationId) return {};
  const url = actionRuntimeUrl();
  return {
    ACTIONS_RUNTIME_URL: url,
    ACTIONS_RESULTS_URL: url,
    ACTIONS_CACHE_URL: url,
    ACTIONS_CACHE_SERVICE_V2: "true",
    ACTIONS_RUNTIME_TOKEN: await runtimeTokens().issue(
      { organizationId: run.organizationId, runId: run.id, jobId: job.id, purpose: "runtime" },
      job.spec!.timeoutSeconds + 300,
    ),
  };
}

export async function authorizeActionRuntime(identity: ActionRuntimeIdentity) {
  const [run, job] = await Promise.all([
    repos.actions.run(identity.organizationId, identity.runId),
    repos.actions.job(identity.organizationId, identity.jobId),
  ]);
  if (!run || !job || job.runId !== run.id) throw new NotFoundError("Actions job");
  const userDownload = identity.purpose === "user-download";
  if (!userDownload && (!job.workerStartedAt || actionFinished(job.status) || job.cleanedAt))
    throw new AppError("This job's runtime access has ended", 403, "ACTIONS_RUNTIME_CLOSED");
  const ctx = await resolveExecutionAuthority(
    userDownload ? identity.viewer : run.authority,
    `actions-runtime:${job.id}`,
  );
  await authorizeActionRun(ctx, run, !userDownload);
  const destination = run.configuration.storageDestinationId;
  if (!destination)
    throw new AppError(
      "This workflow has no artifact storage destination",
      409,
      "ACTIONS_STORAGE_UNCONFIGURED",
    );
  await authorizeActionStorage(ctx, destination, !userDownload);
  return { run, job, identity };
}

let protocol: ActionStorageProtocol | undefined;
export function actionStorageProtocol(): ActionStorageProtocol {
  return (protocol ??= new ActionStorageProtocol({
    repo: repos.actionStorage,
    tokens: runtimeTokens(),
    baseUrl: actionRuntimeUrl,
    authorize: authorizeActionRuntime,
    store: actionStorageDestination,
    reportError: (error, objectId) =>
      diagnostics.warn("actions/storage", "Actions storage cleanup will be retried", error, {
        objectId,
      }),
  }));
}

export async function actionArtifacts(ctx: ExecutionContext, run: ActionRun) {
  await authorizeActionRun(ctx, run);
  if (run.controller === "github")
    return (await import("./github-output")).gitHubArtifacts(ctx, run);
  if (!run.configuration.storageDestinationId) return [];
  await authorizeActionStorage(ctx, run.configuration.storageDestinationId);
  return (await repos.actionStorage.artifacts(ctx.organizationId, run.id)).map((row) => ({
    id: row.id,
    name: row.name,
    size: row.size ?? 0,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  }));
}

export async function actionArtifactDownload(ctx: ExecutionContext, run: ActionRun, id: number) {
  if (run.controller === "github")
    return (await import("./github-output")).gitHubArtifactDownload(ctx, run, id);
  await actionArtifacts(ctx, run);
  const object = await repos.actionStorage.get(ctx.organizationId, id);
  if (
    !object ||
    object.runId !== run.id ||
    object.kind !== "artifact" ||
    object.state !== "complete" ||
    object.expiresAt <= new Date()
  )
    throw new NotFoundError("Actions artifact");
  const token = await runtimeTokens().issue(
    {
      purpose: "user-download",
      organizationId: ctx.organizationId,
      runId: run.id,
      jobId: object.jobId,
      objectId: id,
      viewer: await captureExecutionAuthority(ctx),
    },
    60,
  );
  return { url: `${actionRuntimeUrl()}objects/${id}?token=${encodeURIComponent(token)}` };
}
