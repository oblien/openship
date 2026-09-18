import { Command, Option } from "commander";
import { readFileSync } from "node:fs";
import { getShipClient } from "../lib/ship-client";
import { fail } from "../lib/cmd-helpers";
import { isJsonMode, printJson, printTable, ok, err } from "../lib/output";

function jobOptions(command: Command): Command {
  return command
    .option("--name <name>", "Job label")
    .option("--server <id>", "Target server ID")
    .option("--command <command>", "Shell command to execute on the server")
    .addOption(new Option("--schedule <type>", "Schedule type").choices(["recurring", "once", "manual"]))
    .option("--cron <expression>", "Five-field cron expression")
    .option("--at <iso>", "Run time for a once schedule")
    .option("--file <path>", "JSON API body (env, secrets, retry, etc.); flags override file values");
}

async function saveJob(opts: Record<string, string | boolean>, key?: string): Promise<void> {
  try {
    const body = opts.file ? JSON.parse(readFileSync(String(opts.file), "utf8")) : {};
    for (const [flag, field] of Object.entries({
      name: "label", command: "command", schedule: "scheduleType",
      cron: "cronExpression", at: "runAt", enabled: "enabled",
    })) {
      if (opts[flag] !== undefined) body[field] = opts[flag];
    }
    if (opts.server !== undefined) body.serverIds = [opts.server];
    const jobs = getShipClient().jobs;
    const data = await (key === undefined ? jobs.create(body) : jobs.update(key, body));
    printJson(data);
  } catch (e) {
    fail(e);
  }
}

async function followRun(runId: string): Promise<void> {
  for await (const event of getShipClient().jobs.streamRun(runId)) {
    const data = JSON.parse(event.data);
    if (isJsonMode()) printJson(data);
    else if (data.type === "snapshot" && data.run.output) process.stdout.write(data.run.output + "\n");
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
      fail(e);
    }
  });

jobOptions(jobCommand.command("create").description("Create a custom job (name, server, command, and schedule required)"))
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
        if (data.output) process.stdout.write(data.output + "\n");
        if (data.error) err(data.error);
      }
    } catch (e) {
      fail(e);
    }
  });
