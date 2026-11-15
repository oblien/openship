import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { AppError } from "@repo/core";
import { repos } from "@repo/db";
import { encrypt, decrypt } from "../../../lib/encryption";
import { getProviderAccess } from "../../credentials/connection-authorization";
import { railwayQuery, type ProviderAccess } from "../../credentials/provider-api";
import type { PrivateImportPlan } from "../platform-import-plan";
import { nodes, parseProvider } from "./common";

// This container only keeps the reviewed mounts available through Railway SSH.
// No database clients, source application commands, or public listener are run.
const EXPORT_IMAGE = "alpine:3";
const pendingDeployment = (status: string) =>
  ["INITIALIZING", "QUEUED", "BUILDING", "DEPLOYING", "WAITING", "WAITING_FOR_CLEARANCE"].includes(
    status,
  );
const record = z.record(z.string(), z.unknown());
const deployment = z.object({
  id: z.string(),
  status: z.string(),
  deploymentStopped: z.boolean(),
  meta: record.nullable().optional(),
});
const environment = z.object({
  config: z.object({ services: z.record(z.string(), record) }),
  unmergedChangesCount: z.number().nullable(),
  serviceInstances: nodes(
    z.object({
      serviceId: z.string(),
      activeDeployments: z.array(deployment),
    }),
  ),
});
type Patch = Record<string, unknown>;
interface SourceService {
  id: string;
  name: string;
  deployments: string[];
  original: Patch;
  maintenance: Patch;
  exportData: boolean;
  exportDeployment?: string;
  resumeDeployment?: string;
  resumeRequested?: boolean;
  originalMeta?: { imageDigest?: unknown; commitHash?: unknown; image?: unknown };
}
export interface RailwayTransferState {
  projectId: string;
  environmentId: string;
  services: SourceService[];
  patchRequested?: boolean;
  restored?: boolean;
}

function matchesResumedDeployment(active: z.infer<typeof deployment>, source: SourceService) {
  return (
    Boolean(
      source.originalMeta?.imageDigest ||
      source.originalMeta?.commitHash ||
      source.originalMeta?.image,
    ) &&
    active.meta?.reason === "redeploy" &&
    active.meta?.image === source.originalMeta?.image &&
    active.meta?.imageDigest === source.originalMeta?.imageDigest &&
    active.meta?.commitHash === source.originalMeta?.commitHash &&
    object(object(active.meta?.serviceManifest).deploy).startCommand ===
      object(source.original.deploy).startCommand
  );
}

function object(value: unknown): Patch {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Patch) : {};
}

/** Compare only fields we own. A normal provider null/absent normalization is
 * harmless; an operator's new source/command must never be overwritten. */
export function matchesRailwayPatch(current: Patch, expected: Patch): boolean {
  return Object.entries(expected).every(([key, value]) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? matchesRailwayPatch(object(current[key]), object(value))
      : // Railway removes an explicitly disabled sleep flag from its config.
        key === "sleepApplication"
        ? (current[key] ?? false) === (value ?? false)
        : JSON.stringify(current[key] ?? null) === JSON.stringify(value ?? null),
  );
}

function restoreFields(current: Patch, patch: Patch): Patch {
  return Object.fromEntries(
    Object.entries(patch).map(([key, value]) => [
      key,
      value && typeof value === "object" && !Array.isArray(value)
        ? restoreFields(object(current[key]), object(value))
        : (current[key] ?? null),
    ]),
  );
}

export function railwayMaintenancePatch(runId: string): Patch {
  return {
    source: { image: EXPORT_IMAGE, repo: null },
    configFile: null,
    deploy: {
      startCommand: `sh -c 'exec sleep infinity' openship-export-${runId}`,
      healthcheckPath: null,
      cronSchedule: null,
      preDeployCommand: null,
      registryCredentials: null,
      sleepApplication: false,
    },
  };
}

export interface RailwayTransferDriver {
  query<T>(query: string, variables: Record<string, unknown>): Promise<T>;
  save(state: RailwayTransferState, pending: boolean): Promise<void>;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  log(message: string): void;
}

/** Provider lifecycle only. Bytes still use BackupExecutor/transferVolume, and
 * the ordinary project/deployment pipeline owns the destination. Persist intent
 * before every source mutation so cancellation and process restart can recover. */
export class RailwayProjectTransfer {
  constructor(private readonly driver: RailwayTransferDriver) {}

  private async read(state: Pick<RailwayTransferState, "projectId" | "environmentId">) {
    const response = parseProvider(
      z.object({ environment, environmentStagedChanges: z.object({ patch: record }) }),
      await this.driver.query(
        `query($project: String!, $environment: String!) {
        environment(id: $environment, projectId: $project) {
          config unmergedChangesCount
          serviceInstances(first: 100) { edges { node {
            serviceId activeDeployments { id status deploymentStopped meta }
          } } pageInfo { hasNextPage endCursor } }
        }
        environmentStagedChanges(environmentId: $environment) { patch }
      }`,
        { project: state.projectId, environment: state.environmentId },
      ),
    );
    const result = {
      ...response.environment,
      unmergedChangesCount:
        response.environment.unmergedChangesCount ??
        Object.keys(response.environmentStagedChanges.patch).length,
    };
    if (Object.keys(response.environmentStagedChanges.patch).length)
      result.unmergedChangesCount = Math.max(1, result.unmergedChangesCount);
    if (result.serviceInstances.pageInfo.hasNextPage)
      throw new AppError(
        "Railway returned an incomplete project. Discover it again.",
        409,
        "IMPORT_SOURCE_CHANGED",
      );
    return result;
  }

  private async waitFor(check: () => Promise<boolean>, signal?: AbortSignal, timeoutMs = 180_000) {
    const deadline = Date.now() + timeoutMs;
    do {
      signal?.throwIfAborted();
      if (await check()) return;
      await this.driver.sleep(2000, signal);
    } while (Date.now() < deadline);
    throw new AppError(
      "Railway did not finish the source transition. Recovery will retry; source data was retained.",
      409,
      "IMPORT_SOURCE_TRANSITION_TIMEOUT",
    );
  }

  private async stop(ids: string[], signal?: AbortSignal) {
    for (const id of ids) {
      signal?.throwIfAborted();
      const current = parseProvider(
        z.object({ deployment }),
        await this.driver.query(
          "query($id: String!) { deployment(id: $id) { id status deploymentStopped } }",
          { id },
        ),
      ).deployment;
      if (pendingDeployment(current.status)) {
        await this.driver.query("mutation($id: String!) { deploymentCancel(id: $id) }", { id });
      } else if (!current.deploymentStopped) {
        const result = await this.driver.query<{ deploymentStop: boolean }>(
          "mutation($id: String!) { deploymentStop(id: $id) }",
          { id },
        );
        if (!result.deploymentStop)
          throw new AppError(
            "Railway could not stop a source deployment. No volume copy was started.",
            409,
            "IMPORT_SOURCE_STOP_FAILED",
          );
      }
    }
    await this.waitFor(async () => {
      for (const id of ids) {
        const result = parseProvider(
          z.object({ deployment }),
          await this.driver.query(
            "query($id: String!) { deployment(id: $id) { id status deploymentStopped } }",
            { id },
          ),
        ).deployment;
        if (!result.deploymentStopped || pendingDeployment(result.status)) return false;
      }
      return true;
    }, signal);
  }

  private async patch(state: RailwayTransferState, restoring: boolean, signal?: AbortSignal) {
    const current = await this.read(state);
    if (current.unmergedChangesCount)
      throw new AppError(
        "Railway has staged changes. Resolve them before migration or source recovery; Openship will not apply them.",
        409,
        "IMPORT_SOURCE_STAGED_CHANGES",
      );
    for (const service of state.services) {
      const config = current.config.services[service.id];
      if (
        !config ||
        (!matchesRailwayPatch(config, service.original) &&
          !matchesRailwayPatch(config, service.maintenance))
      )
        throw new AppError(
          `Railway configuration changed for ${service.name}. Review it before restoring the source.`,
          409,
          "IMPORT_SOURCE_CHANGED",
        );
    }
    signal?.throwIfAborted();
    await this.driver.query(
      `mutation($environment: String!, $patch: EnvironmentConfig!) {
        environmentPatchCommit(environmentId: $environment, patch: $patch, skipDeploys: true,
          commitMessage: "Openship project migration")
      }`,
      {
        environment: state.environmentId,
        patch: {
          services: Object.fromEntries(
            state.services.map((s) => [s.id, restoring ? s.original : s.maintenance]),
          ),
        },
      },
    );
    await this.waitFor(async () => {
      const observed = await this.read(state);
      return state.services.every((s) =>
        matchesRailwayPatch(
          observed.config.services[s.id] ?? {},
          restoring ? s.original : s.maintenance,
        ),
      );
    }, signal);
  }

  async prepare(
    runId: string,
    plan: PrivateImportPlan,
    signal: AbortSignal,
  ): Promise<RailwayTransferState> {
    const state: RailwayTransferState = {
      projectId: plan.inventory.source.projectId,
      environmentId: plan.inventory.source.environmentId,
      services: [],
    };
    const current = await this.read(state);
    const selected = new Set(plan.services.map((s) => s.source.id));
    if (current.serviceInstances.edges.some(({ node }) => !selected.has(node.serviceId)))
      throw new AppError(
        "Import the complete Railway project so all writers and dependencies move together.",
        409,
        "IMPORT_PROJECT_INCOMPLETE",
      );
    if (current.unmergedChangesCount)
      throw new AppError(
        "Resolve the project's staged Railway changes before importing.",
        409,
        "IMPORT_SOURCE_STAGED_CHANGES",
      );
    const maintenance = railwayMaintenancePatch(runId);
    for (const service of plan.services) {
      const config = current.config.services[service.source.id];
      const running =
        current.serviceInstances.edges.find(({ node }) => node.serviceId === service.source.id)
          ?.node.activeDeployments ?? [];
      if (
        !config ||
        running.some(
          (d) =>
            pendingDeployment(d.status) ||
            (!d.deploymentStopped && !service.source.deploymentIds?.includes(d.id)),
        )
      )
        throw new AppError(
          "The Railway deployment changed after review. Discover the project again.",
          409,
          "IMPORT_SOURCE_CHANGED",
        );
      state.services.push({
        id: service.source.id,
        name: service.source.name,
        deployments: running.filter((d) => !d.deploymentStopped).map((d) => d.id),
        original: restoreFields(config, maintenance),
        maintenance,
        exportData: service.data === "copy" && service.source.volumes.length > 0,
        originalMeta: running.find((d) => !d.deploymentStopped)?.meta ?? undefined,
      });
    }
    await this.driver.save(state, true);
    this.driver.log("Stopping the Railway project before copying persistent storage");
    await this.stop(
      state.services.flatMap((s) => s.deployments),
      signal,
    );
    state.patchRequested = true;
    await this.driver.save(state, true);
    await this.patch(state, false, signal);
    for (const service of state.services.filter((s) => s.exportData)) {
      signal.throwIfAborted();
      const result = await this.driver.query<{ serviceInstanceDeployV2: string }>(
        "mutation($service: String!, $environment: String!) { serviceInstanceDeployV2(serviceId: $service, environmentId: $environment) }",
        { service: service.id, environment: state.environmentId },
      );
      service.exportDeployment = result.serviceInstanceDeployV2;
      await this.driver.save(state, true);
      await this.waitFor(
        async () => {
          const observed = parseProvider(
            z.object({ deployment }),
            await this.driver.query(
              "query($id: String!) { deployment(id: $id) { id status deploymentStopped } }",
              { id: service.exportDeployment },
            ),
          ).deployment;
          if (["FAILED", "CRASHED", "REMOVED", "SKIPPED"].includes(observed.status))
            throw new AppError(
              `Railway could not prepare storage export for ${service.name}. Source configuration will be restored.`,
              409,
              "IMPORT_EXPORT_UNAVAILABLE",
            );
          return observed.status === "SUCCESS" && !observed.deploymentStopped;
        },
        signal,
        10 * 60_000,
      );
    }
    await this.assertExportOnly(state);
    return state;
  }

  async assertExportOnly(state: RailwayTransferState) {
    const observed = await this.read(state);
    for (const { node } of observed.serviceInstances.edges) {
      const source = state.services.find((s) => s.id === node.serviceId);
      for (const active of node.activeDeployments.filter((d) => !d.deploymentStopped)) {
        const command = object(object(active.meta?.serviceManifest).deploy).startCommand;
        if (!source || command !== object(source.maintenance.deploy).startCommand)
          throw new AppError(
            "A source workload started during the export. Copy stopped; review Railway before retrying.",
            409,
            "IMPORT_SOURCE_STARTED",
          );
      }
    }
  }

  async restore(state: RailwayTransferState, resume: boolean) {
    // Discover by the per-run command marker as well as the receipt: a deploy
    // response can be lost after Railway accepted it.
    if (state.patchRequested && !state.restored) {
      const current = await this.read(state);
      const exporters: string[] = [];
      for (const { node } of current.serviceInstances.edges) {
        const source = state.services.find((s) => s.id === node.serviceId);
        if (!source) continue;
        for (const active of node.activeDeployments.filter(
          (d) => !d.deploymentStopped || pendingDeployment(d.status),
        )) {
          const command = object(object(active.meta?.serviceManifest).deploy).startCommand;
          if (
            command === object(source.maintenance.deploy).startCommand ||
            source.deployments.includes(active.id)
          )
            exporters.push(active.id);
          else
            throw new AppError(
              `A different deployment is running for ${source.name}. Recovery retained its configuration and data.`,
              409,
              "IMPORT_SOURCE_CHANGED",
            );
        }
      }
      await this.stop(exporters);
      await this.patch(state, true);
      state.restored = true;
      await this.driver.save(state, true);
    }
    if (resume) {
      for (const service of state.services) {
        // A previously stopped service remains stopped. Never run a new revision
        // or pull a mutable tag when recovering an interrupted migration.
        if (!service.deployments.length) continue;
        // Configuration may already have been restored before a destination
        // failure. Recheck the whole source even on that recovery path: never
        // supersede an operator's later deployment with our original revision.
        const observed = await this.read(state);
        if (
          observed.unmergedChangesCount ||
          state.services.some(
            (source) =>
              !matchesRailwayPatch(observed.config.services[source.id] ?? {}, source.original),
          )
        )
          throw new AppError(
            "Railway configuration changed before source recovery. Review it before resuming the original workloads.",
            409,
            "IMPORT_SOURCE_CHANGED",
          );
        for (const { node } of observed.serviceInstances.edges) {
          const source = state.services.find((s) => s.id === node.serviceId);
          if (
            node.activeDeployments.some(
              (active) =>
                (!active.deploymentStopped || pendingDeployment(active.status)) &&
                (!source ||
                  (!source.deployments.includes(active.id) &&
                    source.resumeDeployment !== active.id &&
                    !(source.resumeRequested && matchesResumedDeployment(active, source)))),
            )
          )
            throw new AppError(
              "A different Railway deployment started before source recovery. Its configuration and data were retained.",
              409,
              "IMPORT_SOURCE_CHANGED",
            );
        }
        if (!service.resumeDeployment) {
          const running =
            observed.serviceInstances.edges.find(({ node }) => node.serviceId === service.id)?.node
              .activeDeployments ?? [];
          if (running.some((d) => service.deployments.includes(d.id) && !d.deploymentStopped))
            continue;
          if (service.resumeRequested) {
            const resumed = running.find((d) => matchesResumedDeployment(d, service));
            if (!resumed)
              throw new AppError(
                "Railway has not confirmed source recovery. No duplicate deployment was requested; recovery will retry.",
                409,
                "IMPORT_SOURCE_RECOVERY_PENDING",
              );
            service.resumeDeployment = resumed.id;
          } else {
            service.resumeRequested = true;
            await this.driver.save(state, true);
            const result = await this.driver.query<{ deploymentRedeploy: { id: string } }>(
              "mutation($id: String!) { deploymentRedeploy(id: $id, usePreviousImageTag: true) { id } }",
              { id: service.deployments[0] },
            );
            service.resumeDeployment = result.deploymentRedeploy.id;
          }
          await this.driver.save(state, true);
        }
        await this.waitFor(
          async () => {
            const result = parseProvider(
              z.object({ deployment }),
              await this.driver.query(
                "query($id: String!) { deployment(id: $id) { id status deploymentStopped } }",
                { id: service.resumeDeployment },
              ),
            ).deployment;
            return result.status === "SUCCESS" && !result.deploymentStopped;
          },
          undefined,
          10 * 60_000,
        );
      }
    }
    await this.driver.save(state, false);
    this.driver.log(
      resume
        ? "Railway source configuration and deployments restored"
        : "Source configuration restored; Railway workloads remain stopped for cutover",
    );
  }
}

async function controller(runId: string, log: (message: string) => void) {
  const run = await repos.dockerMigrationRun.findById(runId);
  const checkpoint = run?.recovery.providerImport;
  if (!run || !checkpoint)
    throw new AppError("The import checkpoint is unavailable", 409, "IMPORT_CHECKPOINT_MISSING");
  const access: ProviderAccess = await getProviderAccess(
    run.organizationId,
    checkpoint.connectionId,
  );
  return new RailwayProjectTransfer({
    query: (query, variables) => railwayQuery(access, query, variables),
    save: async (state, pending) => {
      const current = (await repos.dockerMigrationRun.findById(runId))?.recovery.providerImport;
      if (!current)
        throw new AppError(
          "The import checkpoint is unavailable",
          409,
          "IMPORT_CHECKPOINT_MISSING",
        );
      await repos.dockerMigrationRun.updateRecovery(runId, {
        providerImport: {
          ...current,
          sourceStateEnc: encrypt(JSON.stringify(state)),
          sourceCleanupPending: pending,
        },
      });
    },
    sleep: async (ms, signal) => {
      await delay(ms, undefined, { signal });
    },
    log,
  });
}

export async function prepareRailwayProjectTransfer(
  runId: string,
  plan: PrivateImportPlan,
  signal: AbortSignal,
  log: (message: string) => void,
) {
  await (await controller(runId, log)).prepare(runId, plan, signal);
}

export async function restoreRailwayProjectTransfer(
  runId: string,
  resume: boolean,
  log: (message: string) => void = () => {},
) {
  const checkpoint = (await repos.dockerMigrationRun.findById(runId))?.recovery.providerImport;
  if (!checkpoint?.sourceStateEnc || (!checkpoint.sourceCleanupPending && !resume)) return;
  await (
    await controller(runId, log)
  ).restore(JSON.parse(decrypt(checkpoint.sourceStateEnc)), resume);
}

export async function assertRailwayExportOnly(runId: string) {
  const checkpoint = (await repos.dockerMigrationRun.findById(runId))?.recovery.providerImport;
  if (!checkpoint?.sourceStateEnc)
    throw new AppError(
      "The source export checkpoint is unavailable",
      409,
      "IMPORT_CHECKPOINT_MISSING",
    );
  await (
    await controller(runId, () => {})
  ).assertExportOnly(JSON.parse(decrypt(checkpoint.sourceStateEnc)));
}
