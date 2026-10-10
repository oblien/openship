import { createHash, randomUUID } from "node:crypto";
import {
  AppError,
  ACTIONS_MAX_JOB_SECONDS,
  actionRunnerMismatch,
  actionContainerPlatform,
  generateId,
  safeErrorMessage,
  type ActionWorkerRequest,
} from "@repo/core";
import { repos, type ActionRunnerSession, type ActionRunner, type ActionWorkflow } from "@repo/db";
import { diagnostics } from "@repo/core/diagnostics";
import { encrypt, decrypt } from "../../lib/encryption";
import { resolveExecutionAuthority } from "../../lib/execution-authority";
import { authorizeActionWorkflow } from "./access";
import { GitHubActionsApi } from "./github-api";
import { openActionWorker, removeActionWorker } from "./worker-execution";

const owner = `github-runners-${randomUUID()}`;
const idleMs = 10 * 60_000;

export function requestsOpenshipRunner(labels: string[]) {
  const normalized = labels.map((label) => label.toLowerCase());
  // Plain ubuntu-latest/macOS labels belong to GitHub-hosted runners. Only an
  // explicit routing choice may allocate customer infrastructure or spend funds.
  return normalized.includes("self-hosted") && normalized.includes("openship");
}

async function reserveDemand(signal?: AbortSignal) {
  for (const { job, workflow } of await repos.actions.queuedGitHubJobs()) {
    if (signal?.aborted) return;
    if (!job.spec || !requestsOpenshipRunner(job.spec.labels)) continue;
    try {
      const ctx = await resolveExecutionAuthority(
        workflow.authority,
        `github-runner-demand:${job.id}`,
      );
      await authorizeActionWorkflow(ctx, workflow, true);
      for (const runnerId of workflow.runnerIds) {
        const runner = await repos.actions.runner(workflow.organizationId, runnerId);
        if (!runner?.enabled || actionRunnerMismatch(runner.capabilities, runner.config, job.spec))
          continue;
        const id = generateId("ags");
        if (
          await repos.actions.reserveRunnerSession({
            id,
            organizationId: workflow.organizationId,
            workflowId: workflow.id,
            runnerId,
            demandJobId: job.id,
            repoOwner: workflow.owner!,
            repoName: workflow.repo!,
            runnerName: `openship-${id}`,
            spec: { ...job.spec, timeoutSeconds: ACTIONS_MAX_JOB_SECONDS },
          })
        )
          break;
      }
    } catch (error) {
      await repos.actions.workflowError(
        workflow.organizationId,
        workflow.id,
        safeErrorMessage(error),
      );
      diagnostics.warn(
        "actions/github-runners",
        "GitHub runner demand could not be admitted",
        error,
        { workflowId: workflow.id, jobId: job.id },
      );
    }
  }
}

function requestFor(
  session: ActionRunnerSession,
  runner: ActionRunner,
  directory: string,
  artifact: { download_url: string; sha256_checksum: string },
  token: string,
): ActionWorkerRequest {
  const capabilities = runner.capabilities!;
  const platform = actionContainerPlatform(capabilities, runner.config, session.spec);
  const architecture = platform
    ? platform === "linux/arm64"
      ? "arm64"
      : "x64"
    : capabilities.architecture;
  const os = runner.config.mode === "container" ? "linux" : capabilities.os;
  const labels = [
    ...new Set([
      "self-hosted",
      "openship",
      os,
      architecture,
      ...runner.config.labels
        .map((value) => value.toLowerCase())
        .filter((label) => !["arm64", "x64", "linux", "macos", "windows"].includes(label)),
    ]),
  ];
  if (session.spec.labels.some((label) => !labels.includes(label.toLowerCase())))
    throw new AppError(
      "The GitHub runner labels changed before registration",
      409,
      "ACTIONS_RUNNER_UNSUPPORTED",
    );
  return {
    version: 1,
    id: session.id,
    directory,
    job: "",
    workflow: "",
    workflowPath: "",
    eventName: "",
    event: {},
    actor: "",
    defaultBranch: "",
    matrix: {},
    strategy: {},
    needs: {},
    environment: {},
    secrets: {},
    variables: {},
    inputs: {},
    platforms: {},
    timeoutSeconds: ACTIONS_MAX_JOB_SECONDS,
    containerCpu: runner.config.cpu,
    containerMemoryMb: runner.config.memoryMb,
    containerPlatform: platform,
    dockerSocket: runner.config.allowDockerSocket,
    github: {
      repository: `${session.repoOwner}/${session.repoName}`,
      name: session.runnerName,
      token,
      labels,
      downloadUrl: artifact.download_url,
      sha256: artifact.sha256_checksum,
      image: runner.config.mode === "container" ? runner.config.image! : "",
    },
  };
}

type RunnerRegistrations = Map<string, Promise<Awaited<ReturnType<GitHubActionsApi["runners"]>>>>;

async function removeRegistration(api: GitHubActionsApi, id: string) {
  try {
    await api.removeRunner(id);
  } catch (error) {
    const status = Number(
      (error as { status?: number; statusCode?: number })?.status ??
        (error as { statusCode?: number })?.statusCode,
    );
    if (status !== 404) throw error;
  }
}

async function reconcileSession(
  candidate: ActionRunnerSession,
  registrations: RunnerRegistrations,
  signal?: AbortSignal,
) {
  let session = await repos.actions.claimRunnerSession(
    candidate.organizationId,
    candidate.id,
    owner,
  );
  if (!session) return;
  const org = session.organizationId;
  let lost = false;
  const timer = setInterval(() => {
    void repos.actions
      .claimRunnerSession(org, candidate.id, owner)
      .then((row) => {
        if (!row) lost = true;
      })
      .catch((error) => {
        lost = true;
        diagnostics.warn("actions/github-runners", "Runner session lease renewal failed", error, {
          sessionId: candidate.id,
        });
      });
  }, 30_000);
  timer.unref?.();
  const update = async (patch: Parameters<typeof repos.actions.updateRunnerSession>[3]) => {
    if (lost) throw new Error("GitHub runner session lease was lost");
    const row = await repos.actions.updateRunnerSession(org, candidate.id, owner, patch);
    if (!row) {
      lost = true;
      throw new Error("GitHub runner session lease was lost");
    }
    session = row;
    return row;
  };
  let runner: ActionRunner | undefined;
  let workflow: ActionWorkflow | undefined;
  try {
    runner = await repos.actions.runner(org, session.runnerId);
    workflow = await repos.actions.workflow(org, session.workflowId);
    if (!runner || !workflow) throw new Error("GitHub runner owner is missing");
    const ctx = await resolveExecutionAuthority(workflow.authority, `github-runner:${session.id}`);
    const api = new GitHubActionsApi(ctx, session.repoOwner, session.repoName);
    // A disabled workflow drains its registration; it does not make a new job.
    try {
      await authorizeActionWorkflow(ctx, workflow, true);
    } catch (error) {
      diagnostics.warn(
        "actions/github-runners",
        "GitHub runner authority is no longer valid",
        error,
        { sessionId: session.id },
      );
      await update({ state: "stopping", error: safeErrorMessage(error) });
    }
    if (!runner.enabled || !workflow.enabled || session.cancelRequestedAt)
      await update({ state: "stopping" });
    // One authenticated read per repository/authority per sweep, even when
    // many jobs start together. No cross-user or persistent authorization cache.
    const key = createHash("sha256")
      .update(JSON.stringify([workflow.authority, session.repoOwner, session.repoName]))
      .digest("hex");
    if (!registrations.has(key)) registrations.set(key, api.runners());
    const registered = (await registrations.get(key)!).find(
      (row) => row.name === session!.runnerName,
    );
    if (registered) {
      if (session.githubRunnerId && session.githubRunnerId !== String(registered.id))
        throw new Error("GitHub runner identity changed");
      await update({
        githubRunnerId: String(registered.id),
        ...(session.state !== "stopping" && {
          state: registered.busy || session.state === "running" ? "running" : "listening",
        }),
      });
    }
    // Ephemeral registrations disappear before Runner.Listener finishes its
    // shutdown. The supervisor journal, not registry disappearance, owns exit.
    if (
      ["preparing", "listening"].includes(session.state) &&
      Date.now() - session.createdAt.getTime() > idleMs
    )
      await update({
        state: "stopping",
        error:
          session.error ??
          "GitHub did not assign a job within 10 minutes. Check its runs-on labels and rerun the job.",
      });
    if (Date.now() - session.createdAt.getTime() > (ACTIONS_MAX_JOB_SECONDS + 900) * 1000)
      await update({
        state: "stopping",
        error: session.error ?? "GitHub runner exceeded its maximum lifetime.",
      });
    if (signal?.aborted || lost) return;
    // Cleanup is a durable phase. Once the supervisor has exited, a retry must
    // not try to open a VM whose asynchronous deletion is already in progress.
    if (session.state === "stopping" && (session.finishedAt || !session.workerStartedAt)) {
      if (!(await removeActionWorker(session, runner, owner, update))) return;
      if (registered) await removeRegistration(api, String(registered.id));
      await update({
        state: "finished",
        finishedAt: session.finishedAt ?? new Date(),
        cleanedAt: new Date(),
        registration: null,
      });
      await repos.actions.requestGitHubSync(org, workflow.id);
      return;
    }
    const execution = await openActionWorker(session, runner, owner, update);
    if (!execution) return;
    try {
      const { worker, binary, directory } = execution;
      if (session.directory !== directory || session.workerBinary !== binary)
        await update({ directory, workerBinary: binary });
      const snapshot = await worker.inspect(binary, directory, session.lastEventSequence);
      if (snapshot.state === "idle" && session.state !== "stopping") {
        if (signal?.aborted || lost) return;
        // Re-probe immediately before registration. An ARM image never claims
        // x64, and a native Mac retains its actual architecture.
        runner = { ...runner, capabilities: execution.capabilities ?? runner.capabilities };
        const capabilities = runner.capabilities!;
        const platform = actionContainerPlatform(capabilities, runner.config, session.spec);
        const architecture = platform
          ? platform === "linux/arm64"
            ? "arm64"
            : "x64"
          : capabilities.architecture;
        const os =
          runner.config.mode === "container" || capabilities.os === "linux" ? "linux" : "osx";
        const artifact = (await api.downloads()).find(
          (item) => item.os === os && item.architecture === architecture,
        );
        if (!artifact)
          throw new AppError(
            "GitHub has no official runner for this destination",
            409,
            "ACTIONS_RUNNER_UNSUPPORTED",
          );
        if (
          !session.registration ||
          !session.registrationExpiresAt ||
          session.registrationExpiresAt.getTime() < Date.now() + 60_000
        ) {
          const registration = await api.registrationToken();
          await update({
            registration: encrypt(registration.token),
            registrationExpiresAt: new Date(registration.expires_at),
          });
        }
        const request = requestFor(
          session,
          runner,
          directory,
          artifact,
          decrypt(session.registration!),
        );
        await update({ workerStartedAt: session.workerStartedAt ?? new Date() });
        await worker.start(binary, directory, request);
        return;
      }
      if (snapshot.state === "running" && session.state === "stopping") {
        await worker.cancel(binary, directory);
        return;
      }
      if (snapshot.events.length)
        await update({ lastEventSequence: snapshot.events.at(-1)!.sequence });
      if (snapshot.hasMore) return;
      if (
        ["finished", "interrupted"].includes(snapshot.state) ||
        (snapshot.state === "idle" && session.state === "stopping")
      ) {
        if (registered) {
          // GitHub may still be publishing its result. Deregister only after the
          // supervised process has exited; results are read from GitHub itself.
          await removeRegistration(api, String(registered.id));
        }
        const unexpectedResult =
          snapshot.result &&
          snapshot.result.conclusion !== "success" &&
          !(snapshot.result.conclusion === "cancelled" && session.state === "stopping");
        const error =
          snapshot.state === "interrupted"
            ? "The GitHub runner was interrupted. Rerun the job in GitHub after cleanup."
            : (snapshot.result?.error ??
              (unexpectedResult
                ? `GitHub runner ${snapshot.result!.conclusion}; rerun the job after cleanup.`
                : session.error));
        await update({
          state: "stopping",
          finishedAt: session.finishedAt ?? new Date(),
          registration: null,
          error: error ?? null,
        });
        if (await removeActionWorker(session, runner, owner, update))
          await update({ state: "finished", cleanedAt: new Date() });
        await repos.actions.requestGitHubSync(org, workflow.id);
        if (error) await repos.actions.workflowError(org, workflow.id, error);
      }
    } finally {
      await execution.release();
    }
  } catch (error) {
    if (!lost) {
      await update({ state: "stopping", error: safeErrorMessage(error) });
      // Even revoked GitHub credentials must not leave a paid VM running. Only
      // endpoint-owned resources are removed; stale registration is retried later.
      if (runner && session) {
        try {
          if (!runner.cloudPoolId && session.workerStartedAt) {
            const execution = await openActionWorker(session, runner, owner, update);
            if (execution) {
              try {
                await execution.worker.cancel(execution.binary, execution.directory);
              } finally {
                await execution.release();
              }
            }
          }
          if (await removeActionWorker(session, runner, owner, update))
            await update({ finishedAt: session.finishedAt ?? new Date(), registration: null });
        } catch (cleanupError) {
          diagnostics.warn(
            "actions/github-runners",
            "GitHub runner cleanup will be retried",
            cleanupError,
            { sessionId: candidate.id },
          );
        }
      }
      if (workflow) await repos.actions.workflowError(org, workflow.id, safeErrorMessage(error));
    }
    diagnostics.warn("actions/github-runners", "GitHub runner reconciliation failed", error, {
      sessionId: candidate.id,
    });
  } finally {
    clearInterval(timer);
    await repos.actions.releaseRunnerSession(org, candidate.id, owner);
  }
}

export async function reconcileGitHubRunners(signal?: AbortSignal) {
  const registrations: RunnerRegistrations = new Map();
  for (const session of await repos.actions.runnerSessions()) {
    if (signal?.aborted) return;
    await reconcileSession(session, registrations, signal);
  }
  if (!signal?.aborted) await reserveDemand(signal);
}
