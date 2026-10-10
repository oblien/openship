import { randomUUID } from "node:crypto";
import {
  AppError,
  actionFinished,
  actionRunnerMismatch,
  actionContainerPlatform,
  type ActionContainerPlatform,
  safeErrorMessage,
  ACTIONS_PROTOCOL_VERSION,
  type ActionConclusion,
  type ActionJobResult,
  type ActionNeedsResult,
  type ActionWorkerRequest,
} from "@repo/core";
import type { ActionJob, ActionRun, ActionRunner, createActionsRepo } from "@repo/db";
import type { ActionsWorker } from "@repo/adapters";
import {
  evaluateJobCondition,
  evaluateTemplate,
  type ActionExpressionContext,
} from "./expressions";
import { concreteJob, expandMatrix } from "./workflow";

export type ActionsRepository = ReturnType<typeof createActionsRepo>;
export interface ActionExecution {
  containerPlatform?: ActionContainerPlatform;
  worker: Pick<ActionsWorker, "inspect" | "start" | "cancel" | "clean">;
  binary: string;
  directory: string;
  release(): Promise<void>;
}
export interface ActionControllerPorts {
  repo: ActionsRepository;
  authorize(run: ActionRun): Promise<void>;
  /** Null means the disposable worker is still provisioning. */
  open(
    run: ActionRun,
    job: ActionJob,
    runner: ActionRunner,
    owner: string,
  ): Promise<ActionExecution | null>;
  secrets(run: ActionRun, job: ActionJob): Promise<Record<string, string>>;
  environment?(run: ActionRun, job: ActionJob): Promise<Record<string, string>>;
  /** Deletes disposable compute after log/result persistence. False means still removing. */
  cleanup(run: ActionRun, job: ActionJob, runner: ActionRunner, owner: string): Promise<boolean>;
  check(
    run: ActionRun,
    job: ActionJob,
  ): Promise<{ id: string | null; error: string | null; unavailable?: boolean }>;
  completed?(run: ActionRun): Promise<void>;
  reportError(error: unknown, context: { runId: string; jobId?: string }): void;
}

export function actionContext(
  run: ActionRun,
  needs: Record<string, ActionNeedsResult> = {},
): ActionExpressionContext {
  return {
    github: {
      ...run.event,
      event: run.event,
      event_name: run.eventName,
      repository: run.configuration.owner
        ? `${run.configuration.owner}/${run.configuration.repo}`
        : "",
      repository_owner: run.configuration.owner ?? "",
      ref: run.ref,
      sha: run.revision,
      actor: run.actor,
      workflow: run.plan.name,
      run_id: run.id,
      run_number: run.number,
      run_attempt: run.attempt,
      ref_name: run.ref.replace(/^refs\/(heads|tags)\//, ""),
      ref_type: run.ref.startsWith("refs/tags/") ? "tag" : "branch",
    },
    inputs: run.inputs,
    vars: run.configuration.variables,
    needs,
    cancelled: !!run.cancelRequestedAt,
  };
}

export function aggregateActionJobs(jobs: ActionJob[]): ActionNeedsResult {
  const failed = jobs.some(
    (j) => ["failure", "timed_out"].includes(j.status) && !j.spec?.continueOnError,
  );
  const result: ActionConclusion = failed
    ? "failure"
    : jobs.some((j) => j.status === "cancelled")
      ? "cancelled"
      : jobs.every((j) => j.status === "skipped")
        ? "skipped"
        : "success";
  const outputs: Record<string, string> = {};
  for (const job of [...jobs].sort(
    (a, b) => (a.finishedAt?.getTime() ?? 0) - (b.finishedAt?.getTime() ?? 0),
  ))
    for (const [key, value] of Object.entries(job.result?.outputs ?? {}))
      if (value !== "") outputs[key] = value;
  return { result, outputs };
}

/** Short durable ticks; jobs execute remotely and survive this controller's lifetime. */
export class ActionController {
  private readonly owner = `actions-${randomUUID()}`;
  private readonly running = new Set<string>();
  constructor(private readonly ports: ActionControllerPorts) {}

  async tick(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    const pending = await this.ports.repo.pendingRuns(50);
    // Each worker is one small reconciliation operation, not a resident task
    // per workflow. Database leases fence other API replicas.
    for (let i = 0; i < pending.length && !signal?.aborted; i += 4)
      await Promise.all(
        pending.slice(i, i + 4).map((run) => this.reconcile(run.organizationId, run.id, signal)),
      );
  }

  async reconcile(org: string, id: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || this.running.has(id)) return;
    this.running.add(id);
    const repo = this.ports.repo;
    let leaseLost = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      let run = await repo.claimRun(org, id, this.owner);
      if (!run) return;
      timer = setInterval(() => {
        void repo
          .claimRun(org, id, this.owner)
          .then((value) => {
            if (!value) leaseLost = true;
          })
          .catch((error) => {
            leaseLost = true;
            this.ports.reportError(error, { runId: id });
          });
      }, 15_000);
      timer.unref?.();
      if (!run.finishedAt) {
        try {
          await this.ports.authorize(run);
        } catch (error) {
          this.ports.reportError(error, { runId: id });
          await repo.updateRun(org, id, this.owner, { error: safeErrorMessage(error) });
          await repo.requestCancel(org, id);
          run = (await repo.run(org, id))!;
        }
        if (!run.cancelRequestedAt && !(await repo.activateRun(org, id, this.owner))) return;
        run = (await repo.run(org, id))!;
        await this.expand(run);
      }
      let jobs = await repo.jobs(org, id);
      for (const job of jobs) {
        if (leaseLost || signal?.aborted) return;
        const siblingsFailed =
          job.spec?.failFast &&
          jobs.some(
            (other) =>
              other.jobKey === job.jobKey &&
              ["failure", "timed_out"].includes(other.status) &&
              !other.spec?.continueOnError,
          );
        if (siblingsFailed && !actionFinished(job.status))
          await repo.updateJob(org, job.id, this.owner, { cancelRequestedAt: new Date() });
        await this.reconcileJob(run, (await repo.job(org, job.id))!, signal);
      }
      run = (await repo.run(org, id))!;
      jobs = await repo.jobs(org, id);
      if (
        !run.finishedAt &&
        run.expandedJobs.length === run.plan.jobs.length &&
        jobs.every((job) => actionFinished(job.status))
      ) {
        const result = run.cancelRequestedAt ? "cancelled" : aggregateActionJobs(jobs).result;
        await repo.updateRun(org, id, this.owner, { status: result, finishedAt: new Date() });
      }
      run = (await repo.run(org, id))!;
      if (run.error && !run.cancelRequestedAt)
        await repo.updateRun(org, id, this.owner, { error: null });
      if (
        run.finishedAt &&
        jobs.every(
          (job) =>
            job.cleanedAt && (job.checkStatus === job.status || job.checkStatus === "unavailable"),
        )
      ) {
        await this.ports.completed?.(run);
        await repo.updateRun(org, id, this.owner, { settledAt: new Date() });
      }
    } catch (error) {
      this.ports.reportError(error, { runId: id });
      // Keep recoverable executions visible; the next lease holder can inspect
      // the same remote journal instead of replaying arbitrary user commands.
      await repo
        .updateRun(org, id, this.owner, { error: safeErrorMessage(error) })
        .catch((e) => this.ports.reportError(e, { runId: id }));
    } finally {
      if (timer) clearInterval(timer);
      await repo
        .releaseRun(org, id, this.owner)
        .catch((error) => this.ports.reportError(error, { runId: id }));
      this.running.delete(id);
    }
  }

  private async expand(run: ActionRun): Promise<void> {
    const repo = this.ports.repo;
    const jobs = await repo.jobs(run.organizationId, run.id);
    for (const definition of run.plan.jobs) {
      if (run.expandedJobs.includes(definition.id)) continue;
      const needs: Record<string, ActionNeedsResult> = {};
      let ready = true;
      for (const dep of definition.needs) {
        const entries = jobs.filter((job) => job.jobKey === dep);
        if (
          !run.expandedJobs.includes(dep) ||
          !entries.length ||
          entries.some((job) => !actionFinished(job.status))
        ) {
          ready = false;
          break;
        }
        needs[dep] = aggregateActionJobs(entries);
      }
      if (!ready && !run.cancelRequestedAt) continue;
      try {
        const context = actionContext(run, needs);
        // failure() includes failed ancestors even when an intermediate job was
        // skipped. The needs context itself must still contain only direct deps.
        const ancestors = new Set<string>();
        const visit = (id: string) => {
          if (ancestors.has(id)) return;
          ancestors.add(id);
          run.plan.jobs.find((candidate) => candidate.id === id)?.needs.forEach(visit);
        };
        definition.needs.forEach(visit);
        context.failed = [...ancestors].some(
          (id) => aggregateActionJobs(jobs.filter((job) => job.jobKey === id)).result === "failure",
        );
        if (run.cancelRequestedAt || !evaluateJobCondition(definition.condition, context)) {
          await repo.expandJobs(run.organizationId, run.id, this.owner, definition.id, [], true);
        } else {
          const matrices = expandMatrix(evaluateTemplate(definition.matrix, context));
          const specs = matrices.map((matrix, index) =>
            concreteJob(
              definition,
              matrix,
              { ...context, strategy: { "job-index": index, "job-total": matrices.length } },
              run.plan,
            ),
          );
          await repo.expandJobs(run.organizationId, run.id, this.owner, definition.id, specs);
        }
      } catch (error) {
        this.ports.reportError(error, { runId: run.id });
        await repo.expandJobs(run.organizationId, run.id, this.owner, definition.id, [], true);
        const failed = (await repo.jobs(run.organizationId, run.id)).find(
          (job) => job.jobKey === definition.id,
        )!;
        await repo.updateJob(run.organizationId, failed.id, this.owner, {
          status: "failure",
          error: safeErrorMessage(error),
          finishedAt: new Date(),
          cleanedAt: new Date(),
        });
      }
    }
  }

  private async reconcileJob(run: ActionRun, job: ActionJob, signal?: AbortSignal): Promise<void> {
    const repo = this.ports.repo;
    const org = run.organizationId;
    const update = (changes: Parameters<ActionsRepository["updateJob"]>[3]) =>
      repo.updateJob(org, job.id, this.owner, changes);
    try {
      // Re-read cancellation for each job, including a click during a slow probe.
      run = (await repo.run(org, run.id))!;
      const cancelled = !!run.cancelRequestedAt || !!job.cancelRequestedAt;
      if (!job.runnerId && !actionFinished(job.status)) {
        if (cancelled) {
          await update({
            status: "cancelled",
            finishedAt: new Date(),
            cleanedAt: new Date(),
            error: null,
          });
          return;
        }
        const runners = (await repo.listRunners(org)).filter(
          (runner) =>
            runner.enabled &&
            run.configuration.runnerIds.includes(runner.id) &&
            (!run.untrusted || !!runner.cloudPoolId),
        );
        const candidates = runners.filter(
          (runner) => !actionRunnerMismatch(runner.capabilities, runner.config, job.spec!),
        );
        for (const runner of candidates)
          if (await repo.reserveRunner(org, job.id, runner.id, this.owner)) break;
        job = (await repo.job(org, job.id))!;
        if (!job.runnerId) {
          const reason = candidates.length
            ? "Waiting for an available runner slot."
            : `No allowed runner supports ${job.spec?.labels.join(", ") || "this job"}${job.spec?.requiresDocker ? " with Docker" : ""}.`;
          await update({ status: "waiting", error: reason });
          return;
        }
      }
      const runner = job.runnerId ? await repo.runner(org, job.runnerId) : undefined;
      if (runner && !job.cleanedAt) {
        if (
          (!job.workerStartedAt && cancelled) ||
          (actionFinished(job.status) && (!job.workerStartedAt || runner.cloudPoolId))
        ) {
          if (!(await this.ports.cleanup(run, job, runner, this.owner))) return;
          await update({
            ...(cancelled && !actionFinished(job.status)
              ? { status: "cancelled" as const, finishedAt: new Date() }
              : {}),
            cleanedAt: new Date(),
          });
          return;
        }
        let execution: ActionExecution | null = null;
        try {
          execution = await this.ports.open(run, job, runner, this.owner);
          if (signal?.aborted) return;
          if (!execution) {
            if (
              !job.workerStartedAt &&
              job.startedAt &&
              Date.now() - job.startedAt.getTime() > 15 * 60_000
            )
              await update({
                status: "failure",
                finishedAt: new Date(),
                error:
                  "The Actions runner did not become ready within 15 minutes. Temporary resources are being removed.",
              });
            return;
          }
          if (job.directory !== execution.directory || job.workerBinary !== execution.binary) {
            await update({ directory: execution.directory, workerBinary: execution.binary });
            job = (await repo.job(org, job.id))!;
          }
          const { worker, directory, binary } = execution;
          let snapshot = await worker.inspect(binary, directory, job.lastEventSequence);
          if (snapshot.state === "idle" && !actionFinished(job.status)) {
            if (cancelled) {
              await worker.clean(binary, directory);
              if (!(await this.ports.cleanup(run, job, runner, this.owner))) return;
              await update({ status: "cancelled", finishedAt: new Date(), cleanedAt: new Date() });
            } else {
              const secrets = await this.ports.secrets(run, job);
              const request = this.request(run, job, runner, directory, secrets);
              request.containerPlatform = execution.containerPlatform ?? request.containerPlatform;
              Object.assign(request.environment, await this.ports.environment?.(run, job));
              if (Buffer.byteLength(JSON.stringify(request)) > 2 * 1024 * 1024)
                throw new AppError(
                  "The workflow's combined inputs, secrets and dependency outputs exceed the 2 MiB job request limit",
                  413,
                  "ACTIONS_REQUEST_TOO_LARGE",
                );
              if (signal?.aborted) return;
              const saved = await repo.startJob(org, job.id, this.owner);
              if (!saved) return;
              await worker.start(binary, directory, request);
            }
            return;
          }
          if ((cancelled || actionFinished(job.status)) && snapshot.state === "running") {
            await worker.cancel(binary, directory);
            if (!actionFinished(job.status)) await update({ status: "cancelling" });
            else return;
          }
          if (snapshot.result && !actionFinished(job.status)) {
            try {
              this.validateResult(snapshot.result);
            } catch (error) {
              this.ports.reportError(error, { runId: run.id, jobId: job.id });
              await update({
                status: "failure",
                error: safeErrorMessage(error),
                finishedAt: new Date(),
              });
              job = (await repo.job(org, job.id))!;
            }
          }
          await repo.appendEvents(org, job.id, this.owner, snapshot.events);
          if (snapshot.hasMore) return; // Drain the journal before releasing the VM.
          if (snapshot.state === "finished" && snapshot.result && !actionFinished(job.status)) {
            await update({
              status: snapshot.result.conclusion,
              result: snapshot.result,
              error: snapshot.result.error ?? null,
              finishedAt: new Date(),
            });
            job = (await repo.job(org, job.id))!;
          } else if (snapshot.state === "interrupted" && !actionFinished(job.status)) {
            await update({
              status: "failure",
              error:
                "The runner stopped before confirming completion. This attempt will not be replayed automatically.",
              finishedAt: new Date(),
            });
            job = (await repo.job(org, job.id))!;
          }
          if (actionFinished(job.status)) {
            if (!runner.cloudPoolId) await worker.clean(binary, directory);
            if (!(await this.ports.cleanup(run, job, runner, this.owner))) return;
            await update({ cleanedAt: new Date() });
          }
        } finally {
          await execution?.release();
        }
      }
    } catch (error) {
      this.ports.reportError(error, { runId: run.id, jobId: job.id });
      const permanent =
        error instanceof Error &&
        "code" in error &&
        [
          "ACTIONS_RUNNER_ASSET_MISSING",
          "ACTIONS_RUNNER_ASSET_INVALID",
          "ACTIONS_RUNNER_UNSUPPORTED",
          "DOCKER_EMULATION_UNAVAILABLE",
          "ACTIONS_CREDITS_REQUIRED",
          "ACTIONS_PROVISIONING_FAILED",
          "ACTIONS_PROVISIONING_REJECTED",
          "ACTIONS_TOKEN_SCOPE_INVALID",
          "ACTIONS_REQUEST_TOO_LARGE",
          "ACTIONS_RUNTIME_URL_REQUIRED",
          "ACTIONS_RUNTIME_URL_INVALID",
        ].includes(String(error.code));
      const preparationExpired =
        !job.workerStartedAt &&
        !!job.startedAt &&
        Date.now() - job.startedAt.getTime() > 15 * 60_000;
      const workerLost = error instanceof AppError && error.code === "ACTIONS_WORKER_LOST";
      await update({
        // Cleanup can outlive execution. Report its failures to diagnostics,
        // but preserve the completed job's actual result and failure message.
        error: actionFinished(job.status) ? job.error : safeErrorMessage(error),
        ...(workerLost || (!job.workerStartedAt && (permanent || preparationExpired))
          ? { status: "failure" as const, finishedAt: new Date() }
          : {}),
      });
    } finally {
      job = (await repo.job(org, job.id))!;
      if (
        job.checkStatus !== job.status &&
        job.checkStatus !== "unavailable" &&
        (!job.checkRetryAt || job.checkRetryAt <= new Date())
      ) {
        try {
          const result = await this.ports.check(run, job);
          await update({
            checkRunId: result.id,
            checkError: result.error,
            checkStatus: result.unavailable
              ? "unavailable"
              : result.error
                ? job.checkStatus
                : job.status,
            checkRetryAt: result.error ? new Date(Date.now() + 60_000) : null,
          });
        } catch (error) {
          this.ports.reportError(error, { runId: run.id, jobId: job.id });
          await update({
            checkError: safeErrorMessage(error),
            checkRetryAt: new Date(Date.now() + 60_000),
          });
        }
      }
    }
  }

  private validateResult(result: ActionJobResult): void {
    if (
      !actionFinished(result.conclusion) ||
      !result.outputs ||
      Array.isArray(result.outputs) ||
      !result.steps ||
      Array.isArray(result.steps) ||
      Buffer.byteLength(JSON.stringify(result)) > 128 * 1024 ||
      Object.values(result.outputs).some((v) => typeof v !== "string") ||
      Object.values(result.steps).some(
        (step) =>
          !step ||
          !["success", "failure", "skipped"].includes(step.outcome) ||
          !["success", "failure", "skipped"].includes(step.conclusion),
      )
    )
      throw new Error(
        "Actions worker returned an invalid job result. This attempt will not be replayed.",
      );
  }

  private request(
    run: ActionRun,
    job: ActionJob,
    runner: ActionRunner,
    directory: string,
    secrets: Record<string, string>,
  ): ActionWorkerRequest {
    const spec = job.spec!;
    return {
      version: ACTIONS_PROTOCOL_VERSION,
      id: job.id,
      workflow: run.source,
      workflowPath: run.configuration.path,
      job: spec.jobId,
      directory: `${directory}/work`,
      eventName: run.eventName,
      event: run.event,
      actor: run.actor,
      defaultBranch: run.configuration.defaultBranch,
      matrix: spec.matrix,
      strategy: spec.strategy,
      needs: spec.needs,
      environment: {
        GITHUB_REPOSITORY: run.configuration.owner
          ? `${run.configuration.owner}/${run.configuration.repo}`
          : "",
        GITHUB_REPOSITORY_OWNER: run.configuration.owner ?? "",
        GITHUB_REF: run.ref,
        SHA_REF: run.revision,
        GITHUB_RUN_ID: run.id,
        GITHUB_RUN_NUMBER: String(run.number),
        GITHUB_RUN_ATTEMPT: String(run.attempt),
        GITHUB_RETENTION_DAYS: "30",
      },
      secrets,
      variables: run.untrusted ? {} : run.configuration.variables,
      inputs: Object.fromEntries(
        Object.entries(run.inputs).map(([key, value]) => [key, String(value)]),
      ),
      platforms: Object.fromEntries(
        spec.labels.map((label) => [
          label,
          runner.config.mode === "native" ? "-self-hosted" : runner.config.image!,
        ]),
      ),
      timeoutSeconds: spec.timeoutSeconds,
      containerCpu: runner.config.cpu,
      containerMemoryMb: runner.config.memoryMb,
      containerPlatform: runner.capabilities
        ? actionContainerPlatform(runner.capabilities, runner.config, spec)
        : undefined,
      dockerSocket: runner.config.allowDockerSocket,
    };
  }
}
