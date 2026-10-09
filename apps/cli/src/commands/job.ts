import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { Command, Option } from "commander";
import { readFileSync } from "node:fs";
import type { CreateJobInput, UpdateJobInput } from "@repo/sdk";
import type { JobRun } from "@repo/contracts";
import { getShipClient } from "../lib/ship-client";
import { fail, printResult } from "../lib/cmd-helpers";
import { isJsonMode, printJson, printTable, ok, err } from "../lib/output";

function jobOptions(command: Command): Command {
  return command
    .option("--name <name>", "Job label")
    .option("--server <id>", "Target server ID")
    .option("--command <command>", "Shell command to execute on the server")
    .addOption(new Option("--schedule <type>", "Schedule type").choices(["recurring", "once", "manual"]))
    .option("--cron <expression>", "Five-field cron expression")
    .option("--at <iso>", "Run time for a once schedule")
    .option("--file <path>", "JSON API body (workflowId/inputs or command settings); flags override file values");
}

async function saveJob(opts: Record<string, string | boolean>, key?: string): Promise<void> {
  try {
    let body: Record<string, unknown> = {};
    if (opts.file) {
      const contents = readFileSync(String(opts.file), "utf8");
      try { body = JSON.parse(contents); }
      catch { throw new Error("Job configuration must be valid JSON"); }
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw new Error("Job configuration must be a JSON object");
      }
    }
    for (const [flag, field] of Object.entries({
      name: "label", command: "command", schedule: "scheduleType",
      cron: "cronExpression", at: "runAt", enabled: "enabled",
    })) {
      if (opts[flag] !== undefined) body[field] = opts[flag];
    }
    if (opts.server !== undefined) {
      delete body.serverId;
      body.serverIds = [opts.server];
    }
    const jobs = getShipClient().jobs;
    // The SDK validates the combined file and flag input against the shared contract.
    const data = await (key === undefined ? jobs.create(body as CreateJobInput) : jobs.update(key, body as UpdateJobInput));
    printJson(data);
  } catch (e) {
    observeCaughtError(e, "cli/commands/job");
    fail(e);
  }
}

function printRunOutput(run: JobRun): void {
  if (run.kind === "workflow") {
    process.stdout.write(`Actions run ${run.id} · ${run.status}\nOpen Actions → Runs in the dashboard for job and step output.\n`);
  } else if (run.output) process.stdout.write(run.output + "\n");
}

async function followRun(runId: string): Promise<void> {
  for await (const event of getShipClient().jobs.streamRun(runId)) {
    const data = JSON.parse(event.data);
    if (isJsonMode()) printJson(data);
    else if (data.type === "snapshot") printRunOutput(data.run);
    else if (data.type === "log") process.stdout.write(data.line + "\n");
    if (data.type === "complete") {
      if (data.status !== "success") {
        err(data.error ?? `Job ${data.status}`);
        process.exitCode = 1;
      }
      return;
    }
  }
  throw new Error("Job stream ended before completion; inspect the run with job logs.");
}

export const jobCommand = new Command("job")
  .alias("jobs")
  .description("Manage self-hosted jobs, schedules, and run logs");

jobCommand.command("list")
  .description("List system and custom jobs")
  .action(async () => {
    try {
      const data = await getShipClient().jobs.list();
      printTable(data, ["key", "label", "kind", "enabled", "scheduleType", "cronExpression", "nextRunAt"]);
    } catch (e) {
      observeCaughtError(e, "cli/commands/job");
      fail(e);
    }
  });

jobCommand.command("get <key>")
  .description("Show a job's configuration and recent runs")
  .action(async (key: string) => {
    try {
      const data = await getShipClient().jobs.get(key);
      printJson(data);
    } catch (e) {
      observeCaughtError(e, "cli/commands/job");
      fail(e);
    }
  });

jobOptions(jobCommand.command("create").description("Create a scheduled command or saved workflow job"))
  .action((opts) => saveJob(opts));

jobOptions(jobCommand.command("update <key>").description("Update a job; built-ins accept schedule and enabled changes"))
  .option("--enabled", "Enable the job")
  .option("--no-enabled", "Disable the job")
  .action((key: string, opts) => saveJob(opts, key));

jobCommand.command("delete <key>")
  .alias("rm")
  .description("Delete a custom job (system jobs cannot be deleted)")
  .requiredOption("-y, --yes", "Confirm deletion")
  .action(async (key: string) => {
    try {
      const result = await getShipClient().jobs.remove(key);
      if (isJsonMode()) printJson(result);
      else ok(`Deleted ${key}`);
    } catch (e) {
      observeCaughtError(e, "cli/commands/job");
      fail(e);
    }
  });

jobCommand.command("run <key>")
  .description("Run a job now; custom jobs return a run ID")
  .option("-f, --follow", "Stream the custom run until completion")
  .action(async (key: string, opts) => {
    try {
      const data = await getShipClient().jobs.run(key);
      printJson(data);
      if (opts.follow && data.runId) await followRun(data.runId);
    } catch (e) {
      observeCaughtError(e, "cli/commands/job");
      fail(e);
    }
  });

jobCommand.command("runs <key>")
  .description("List a job's run history")
  .option("--limit <n>", "Maximum number of runs (default 50)")
  .action(async (key: string, opts) => {
    try {
      const data = await getShipClient().jobs.listRuns(key, opts.limit ? { limit: Number(opts.limit) } : undefined);
      printTable(data, ["id", "trigger", "status", "startedAt", "durationMs", "error"]);
    } catch (e) {
      observeCaughtError(e, "cli/commands/job");
      fail(e);
    }
  });

jobCommand.command("logs <runId>")
  .description("Show stored run output, or the full run in JSON mode")
  .option("-f, --follow", "Stream output until completion; exit nonzero on failure")
  .action(async (runId: string, opts) => {
    try {
      if (opts.follow) {
        await followRun(runId);
        return;
      }
      const data = await getShipClient().jobs.getRun(runId);
      if (isJsonMode()) printJson(data);
      else {
        printRunOutput(data);
        if (data.error) err(data.error);
      }
    } catch (e) {
      observeCaughtError(e, "cli/commands/job");
      fail(e);
    }
  });
jobCommand.command("events").description("List event types available as job triggers")
  .action(() => printResult(() => getShipClient().jobs.triggerEvents()));
jobCommand.command("backup-schedules").description("List scheduled backups with their next and last runs")
  .action(() => printResult(() => getShipClient().jobs.backupSchedules()));
