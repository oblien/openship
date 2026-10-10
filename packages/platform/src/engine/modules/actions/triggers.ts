import { createHash } from "node:crypto";
import cronParser from "cron-parser";
import { repos } from "@repo/db";
import { ValidationError, isFullCommitSha, safeErrorMessage } from "@repo/core";
import { diagnostics } from "@repo/core/diagnostics";
import { nativeJobsEnabled } from "../../native/execution-policy";
import { resolveExecutionAuthority } from "../../lib/execution-authority";
import { githubFetch } from "../github/github.auth";
import { getFileContent } from "../github/github.service";
import { triggerActionWorkflow, rerunActionWorkflow } from "./action.service";
import { parseActionWorkflow, record } from "./workflow";
import { matchesActionFilters } from "./trigger-pattern";
import { ActionWebhookInbox } from "./webhook-inbox";

/** Called only after the delivering GitHub App signature has been verified. */
export async function enqueueActionWebhook(
  eventName: string,
  value: unknown,
  delivery: string,
): Promise<void> {
  if (
    !nativeJobsEnabled() ||
    !delivery ||
    !["push", "pull_request", "check_run", "workflow_run", "workflow_job"].includes(eventName)
  )
    return;
  const event = record(value);
  const repository = record(event.repository);
  const installationId = record(event.installation).id;
  if (typeof repository.full_name !== "string" || !Number.isSafeInteger(installationId)) return;
  if (Buffer.byteLength(JSON.stringify(event)) > 2 * 1024 * 1024)
    throw new ValidationError("Actions webhook payload exceeds 2 MiB");
  const [owner, repo] = repository.full_name.split("/");
  if (!owner || !repo) return;
  for (const workflow of await repos.actions.matchingWorkflows(owner, repo)) {
    const installation = await repos.gitInstallation.findByOrgAndOwner(
      workflow.organizationId,
      owner,
    );
    if (installation?.installationId !== installationId) continue;
    await repos.actions.enqueueDelivery({
      organizationId: workflow.organizationId,
      workflowId: workflow.id,
      eventName,
      deliveryId: delivery,
      payload: event,
    });
  }
}

export const actionWebhookInbox = new ActionWebhookInbox({
  repo: repos.actions,
  dispatch: (item) => dispatchActionWebhook(item.eventName, item.payload, item.deliveryId, item),
  reportError: (error, item) =>
    diagnostics.warn("actions/webhook", "Workflow delivery failed", error, {
      workflowId: item.workflowId,
      delivery: item.deliveryId,
    }),
});

/** Rechecks the current installation and delegation, including after restart. */
export async function dispatchActionWebhook(
  eventName: string,
  value: unknown,
  delivery: string,
  target: { organizationId: string; workflowId: string },
): Promise<void> {
  if (
    !nativeJobsEnabled() ||
    !delivery ||
    !["push", "pull_request", "check_run", "workflow_run", "workflow_job"].includes(eventName)
  )
    return;
  const event = record(value);
  const repository = record(event.repository);
  const installationId = record(event.installation).id;
  if (typeof repository.full_name !== "string" || !Number.isSafeInteger(installationId)) return;
  const [owner, repo] = repository.full_name.split("/");
  if (!owner || !repo) return;
  for (const workflow of await repos.actions.matchingWorkflows(owner, repo)) {
    if (workflow.organizationId !== target.organizationId || workflow.id !== target.workflowId)
      continue;
    const installation = await repos.gitInstallation.findByOrgAndOwner(
      workflow.organizationId,
      owner,
    );
    if (installation?.installationId !== installationId) continue;
    try {
      const ctx = await resolveExecutionAuthority(
        workflow.authority,
        `actions-webhook:${workflow.id}`,
      );
      if (workflow.controller === "github") {
        await repos.actions.requestGitHubSync(workflow.organizationId, workflow.id);
        continue;
      }
      if (eventName === "workflow_run" || eventName === "workflow_job") continue;
      if (eventName === "check_run") {
        const check = record(event.check_run);
        if (event.action !== "rerequested" || !Number.isSafeInteger(check.id)) continue;
        const job = await repos.actions.jobByCheck(workflow.organizationId, String(check.id));
        if (!job) continue;
        const run = await repos.actions.run(workflow.organizationId, job.runId);
        if (run?.workflowId === workflow.id)
          await rerunActionWorkflow(ctx, run.id, `github-${delivery}`);
        continue;
      }
      let ref: string;
      let revision: string;
      let workflowRevision: string | undefined;
      let untrusted = false;
      if (eventName === "push") {
        if (
          event.deleted ||
          typeof event.ref !== "string" ||
          typeof event.after !== "string" ||
          !isFullCommitSha(event.after)
        )
          continue;
        ref = event.ref;
        revision = event.after as string;
      } else {
        const pr = record(event.pull_request);
        const base = record(pr.base);
        const head = record(pr.head);
        if (
          typeof pr.merge_commit_sha !== "string" ||
          typeof base.sha !== "string" ||
          !isFullCommitSha(pr.merge_commit_sha) ||
          !isFullCommitSha(base.sha) ||
          !Number.isSafeInteger(event.number)
        )
          continue;
        revision = pr.merge_commit_sha as string;
        workflowRevision = base.sha as string;
        ref = `refs/pull/${event.number}/merge`;
        untrusted = record(head.repo).full_name !== repository.full_name;
        if (untrusted && !workflow.allowForks) continue;
      }
      const source =
        workflow.source ??
        (
          await getFileContent(ctx, owner, repo, workflow.path, {
            branch: workflowRevision ?? revision,
          })
        ).content;
      const plan = await parseActionWorkflow(source, workflow.path);
      if (
        !workflow.source &&
        eventName === "push" &&
        ref === `refs/heads/${repository.default_branch}`
      )
        await repos.actions.refreshDefinition(
          workflow.organizationId,
          workflow.id,
          plan,
          workflow.updatedAt,
        );
      if (!(eventName in plan.triggers)) continue;
      const filter = record(plan.triggers[eventName]);
      if (
        eventName === "pull_request" &&
        !(
          Array.isArray(filter.types) ? filter.types : ["opened", "synchronize", "reopened"]
        ).includes(String(event.action))
      )
        continue;
      const pr = record(event.pull_request);
      const branch =
        eventName === "pull_request"
          ? String(record(pr.base).ref)
          : ref.replace(/^refs\/(heads|tags)\//, "");
      const kind = ref.startsWith("refs/tags/") ? "tags" : "branches";
      const opposite = kind === "tags" ? "branches" : "tags";
      if (
        eventName === "push" &&
        filter[kind] === undefined &&
        filter[`${kind}-ignore`] === undefined &&
        (filter[opposite] !== undefined || filter[`${opposite}-ignore`] !== undefined)
      )
        continue;
      if (
        !matchesActionFilters(filter[kind], [branch]) ||
        !matchesActionFilters(filter[`${kind}-ignore`], [branch], true)
      )
        continue;
      if (
        !ref.startsWith("refs/tags/") &&
        (filter.paths !== undefined || filter["paths-ignore"] !== undefined)
      ) {
        let files: string[] = [];
        let complete = true;
        const baseUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
        if (eventName === "pull_request") {
          for (let page = 1; page <= 30; page++) {
            const batch = await githubFetch<Array<{ filename: string }>>({
              ctx,
              owner,
              repo,
              url: `${baseUrl}/pulls/${event.number}/files?per_page=100&page=${page}`,
            });
            files.push(...batch.map((file) => file.filename));
            if (batch.length < 100) break;
            if (page === 30) complete = false;
          }
        } else if (
          typeof event.before === "string" &&
          isFullCommitSha(event.before) &&
          !/^0+$/.test(event.before)
        ) {
          const compare = await githubFetch<{
            files?: Array<{ filename: string }>;
            total_commits: number;
          }>({ ctx, owner, repo, url: `${baseUrl}/compare/${event.before}...${revision}` });
          files = (compare.files ?? []).map((file) => file.filename);
          complete = files.length < 300 && compare.total_commits <= 1000;
        } else complete = false;
        // A truncated diff must not silently suppress a required workflow.
        if (
          complete &&
          (!matchesActionFilters(filter.paths, files) ||
            !matchesActionFilters(filter["paths-ignore"], files, true))
        )
          continue;
      }
      await triggerActionWorkflow(ctx, workflow, {
        eventName: eventName === "push" ? "push" : "pull_request",
        key: delivery,
        ref,
        revision,
        workflowRevision,
        event,
        untrusted,
        actor: String(record(event.sender).login ?? "github"),
      });
      await repos.actions.workflowError(workflow.organizationId, workflow.id, null);
    } catch (error) {
      await repos.actions.workflowError(
        workflow.organizationId,
        workflow.id,
        safeErrorMessage(error),
      );
      diagnostics.warn("actions/webhook", "Workflow trigger failed", error, {
        workflowId: workflow.id,
        delivery,
      });
      throw error;
    }
  }
}

export async function dispatchActionSchedules(now = new Date()): Promise<void> {
  if (!nativeJobsEnabled()) return;
  for (const workflow of await repos.actions.matchingWorkflows()) {
    if (workflow.controller === "github") continue;
    const schedule = workflow.definition.triggers.schedule;
    if (!Array.isArray(schedule)) continue;
    for (const entry of schedule) {
      const cron = record(entry).cron;
      if (typeof cron !== "string") continue;
      try {
        const interval = cronParser.parseExpression(cron, {
          currentDate: new Date(now.getTime() + 1),
          tz: "UTC",
        });
        const due = interval.prev().toDate();
        if (due < workflow.createdAt || now.getTime() - due.getTime() > 60_000) continue;
        const ctx = await resolveExecutionAuthority(
          workflow.authority,
          `actions-schedule:${workflow.id}`,
        );
        const key = createHash("sha256").update(`${cron}:${due.toISOString()}`).digest("hex");
        await triggerActionWorkflow(ctx, workflow, {
          eventName: "schedule",
          key,
          event: { schedule: cron },
        });
        await repos.actions.workflowError(workflow.organizationId, workflow.id, null);
      } catch (error) {
        await repos.actions.workflowError(
          workflow.organizationId,
          workflow.id,
          safeErrorMessage(error),
        );
        diagnostics.warn("actions/schedule", "Workflow schedule failed", error, {
          workflowId: workflow.id,
        });
      }
    }
  }
}
