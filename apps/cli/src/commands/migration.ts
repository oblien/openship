import { Command, Option } from "commander";
import {
  MigrationRequestSchemas as input,
  MigrationRevealEnvSchema,
  MigrationScopedSchemas,
  isRecord,
  isResourceOutput,
} from "@repo/contracts";
import { getRemoteClient } from "../lib/ship-client";
import { confirmOrExit, printResult } from "../lib/cmd-helpers";
import { jsonCommand, jsonResourceCommand } from "../lib/json-command";
import { printEvents } from "../lib/event-output";
import { readSecret, timeoutMilliseconds } from "../lib/command-input";

const migrations = () => getRemoteClient().migrations;
export const migrationCommand = new Command("migration").description(
  "Discover, import, move and copy Docker workloads between authorized servers, including Cloud",
);
const source = migrationCommand
  .command("source")
  .description("Manage migration-only SSH sources; these cannot run general server commands");
source
  .command("list")
  .description("List registered migration sources")
  .action(() => printResult(() => migrations().listSources()));
jsonCommand(
  source
    .command("test")
    .description("Verify source access and return its SSH fingerprint without saving it"),
  input.source,
  (value) => migrations().testSource(value),
);
jsonCommand(
  source.command("add").description("Connect a source using credentials from a JSON file or stdin"),
  input.source,
  (value) => migrations().createSource(value),
);
source
  .command("remove")
  .argument("<id>")
  .option("-y, --yes", "Confirm disconnect")
  .description("Delete saved migration access; retain source workloads and data")
  .action((id: string, opts) =>
    printResult(async () => {
      await confirmOrExit(opts.yes, `Remove migration access to ${id}?`);
      return migrations().removeSource(id);
    }),
  );

migrationCommand
  .command("scan")
  .argument("<server>")
  .option("--flat-docker", "Include managed containers in the Docker scan")
  .option("--follow", "Stream scan progress")
  .option("--timeout <ms>", "Bound the streaming scan", timeoutMilliseconds, 120_000)
  .description(
    "Read Docker services, container IDs, routes and volumes with environment values masked",
  )
  .action((serverId: string, opts) => {
    const value = { serverId, flatDocker: !!opts.flatDocker };
    if (opts.follow)
      return printEvents(
        migrations().scanEvents(value, { signal: AbortSignal.timeout(opts.timeout) }),
        {
          event: "result",
          successful: (data) =>
            isRecord(data) && isResourceOutput(MigrationScopedSchemas.scan, data.stack),
        },
      );
    return printResult(() => migrations().scan(value));
  });

for (const [name, schema, method, description, confirmation] of [
  [
    "repo-compose",
    input.repoCompose,
    "repoCompose",
    "Read repository Compose services with environment values masked",
    undefined,
  ],
  [
    "preview",
    input.preview,
    "preview",
    "Inspect transfer size, blocked services, conflicts and downtime before moving",
    undefined,
  ],
  [
    "adopt",
    input.adopt,
    "adopt",
    "Register discovered services in place on a self-hosted controller",
    "Register the selected running services?",
  ],
  [
    "reimport",
    input.reimport,
    "reimport",
    "Recover a scanned orphaned Openship project with its original ID",
    "Re-register the scanned project?",
  ],
  [
    "start",
    input.migrate,
    "start",
    "Start the reviewed Docker migration; keep killOriginals false to review cutover",
    "Start this migration with the supplied data and retirement choices?",
  ],
  [
    "project",
    input.project,
    "moveProject",
    "Move or copy an existing project; the run waits for explicit cutover",
    "Start this project move or copy?",
  ],
] as const) {
  // Each callback retains its schema-specific signature despite the heterogeneous command table.
  jsonCommand(
    migrationCommand.command(name).description(description),
    schema,
    (value) => (migrations()[method] as (input: typeof value) => Promise<unknown>)(value),
    confirmation,
  );
}
jsonCommand(
  migrationCommand
    .command("reveal-env")
    .description("Print only the requested environment keys from one source container (secrets)"),
  MigrationRevealEnvSchema,
  (value) => migrations().revealEnv(value),
  "Reveal the selected source environment values in terminal output?",
);
migrationCommand
  .command("get")
  .argument("<id>")
  .description("Read durable state, logs, transfer progress, pending prompts and cutover token")
  .action((id: string) => printResult(() => migrations().get(id)));
migrationCommand
  .command("active")
  .argument("<server>")
  .description("Find an active run before starting or reattaching to work")
  .action((serverId: string) => printResult(() => migrations().active({ serverId })));
migrationCommand
  .command("list")
  .option("--server <id>", "Source or target server")
  .option("--project <id>", "Project ID")
  .description("List up to 50 runs for a server or project")
  .action((opts) =>
    printResult(() => migrations().listRuns({ serverId: opts.server, projectId: opts.project })),
  );
migrationCommand
  .command("events")
  .argument("<id>")
  .description("Reattach to a migration's progress without restarting it")
  .action((id: string) =>
    printEvents(migrations().events(id), {
      event: "complete",
      successful: (data) => isRecord(data) && data.status === "succeeded",
    }),
  );
migrationCommand
  .command("respond")
  .argument("<id>")
  .requiredOption("--prompt <id>", "Current pending prompt ID")
  .requiredOption("--action <id>", "An action offered by that prompt")
  .option("-y, --yes", "Confirm the offered action")
  .description("Respond to the exact pending decision returned by migration get")
  .action((id: string, opts) =>
    printResult(async () => {
      await confirmOrExit(opts.yes, `Apply prompt ${opts.prompt}'s action ${opts.action}?`);
      return migrations().respond(id, { promptId: opts.prompt, action: opts.action });
    }),
  );
jsonResourceCommand(
  migrationCommand
    .command("resume")
    .description("Resume a partial run with reviewed path overrides or skips"),
  input.resume,
  (id, value) => migrations().resume(id, value),
  "Resume this migration with the supplied path choices?",
);
migrationCommand
  .command("cutover")
  .argument("<id>")
  .requiredOption("--token-file <file>", "This run's confirmation token, or - for stdin")
  .addOption(
    new Option("--originals <choice>", "Retain source containers or authorize their destruction")
      .choices(["retain", "retire"])
      .makeOptionMandatory(),
  )
  .option("-y, --yes", "Confirm cutover")
  .description(
    "Confirm the reviewed target; never invents a cutover token or changes the retirement choice",
  )
  .action((id: string, opts) =>
    printResult(async () => {
      const confirmationToken = readSecret(opts.tokenFile);
      await confirmOrExit(
        opts.yes,
        `Confirm cutover for ${id} and ${opts.originals} its source containers?`,
      );
      return migrations().cutover(id, { confirmationToken, kill: opts.originals === "retire" });
    }),
  );
for (const [name, method, description] of [
  ["cancel", "cancel", "Request cancellation and rollback; poll migration get until it finishes"],
  [
    "cleanup-target",
    "cleanupTarget",
    "Delete target volumes copied by a failed migration; source data remains",
  ],
  [
    "remove",
    "remove",
    "Delete a terminal run's history record; retain the migrated project and data",
  ],
] as const) {
  migrationCommand
    .command(name)
    .argument("<id>")
    .option("-y, --yes", "Confirm operation")
    .description(description)
    .action((id: string, opts) =>
      printResult(async () => {
        await confirmOrExit(opts.yes, `${description} (${id})?`);
        return migrations()[method](id);
      }),
    );
}
