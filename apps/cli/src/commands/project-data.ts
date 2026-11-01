import { Command } from "commander";
import { ProjectControlSchemas as schemas, parseInput } from "@repo/contracts";
import { getShipClient } from "../lib/ship-client";
import { positiveInteger, timeoutMilliseconds } from "../lib/command-input";
import { printResult } from "../lib/cmd-helpers";
import { jsonResourceCommand } from "../lib/json-command";
import { printEvents } from "../lib/event-output";

export const projectClusterCommand = new Command("cluster").description(
  "Configure cluster placement and scale a deployed workload",
);
projectClusterCommand
  .command("get")
  .argument("<project>", "Project ID")
  .description("Read placement, replicas and the revision required for changes")
  .action((id: string) => printResult(() => getShipClient().projects.getClusterWorkload(id)));
jsonResourceCommand(
  projectClusterCommand
    .command("set")
    .description("Set or clear cluster placement: acknowledgePlacement for Swarm, stateless for Kubernetes"),
  schemas.setClusterTarget.input,
  (id, input) => getShipClient().projects.setClusterTarget(id, input),
  "Change this project's deployment target?",
);
projectClusterCommand
  .command("scale")
  .argument("<project>", "Project ID")
  .argument("<replicas>", "Desired replicas", positiveInteger)
  .requiredOption("--deployment <id>", "Active deployment ID from cluster get")
  .requiredOption("--updated-at <timestamp>", "Exact updatedAt from cluster get")
  .description("Scale the reviewed deployment; returns the new deployment ID to follow")
  .action((id: string, replicas: number, opts) =>
    printResult(() =>
      getShipClient().projects.scaleClusterWorkload(
        id,
        parseInput(schemas.scaleClusterWorkload.input, {
          replicas,
          expectedDeploymentId: opts.deployment,
          expectedUpdatedAt: opts.updatedAt,
        }),
      ),
    ),
  );

export const projectDatabaseCommand = new Command("database").description(
  "Manage project databases, replicas, backups and application connections",
);
projectDatabaseCommand
  .command("list")
  .argument("<project>", "Project ID")
  .description("List project databases and their operation sequences")
  .action((id: string) => printResult(() => getShipClient().projects.listClusterDatabases(id)));
projectDatabaseCommand
  .command("imports")
  .argument("<project>", "Project ID")
  .description("List backup artifacts available to import into a database")
  .action((id: string) =>
    printResult(() => getShipClient().projects.listClusterDatabaseImports(id)),
  );
projectDatabaseCommand
  .command("get")
  .argument("<project>", "Project ID")
  .argument("<database>", "Database ID")
  .option("--observe", "Refresh observed database health")
  .description("Read database health, backups and progress")
  .action((id: string, databaseId: string, opts) =>
    printResult(() =>
      getShipClient().projects.getClusterDatabase(id, { databaseId, observe: opts.observe }),
    ),
  );
jsonResourceCommand(
  projectDatabaseCommand
    .command("create")
    .description("Provision a database, optionally from an import, copy or backup"),
  schemas.createClusterDatabase.input,
  (id, input) => getShipClient().projects.createClusterDatabase(id, input),
);
jsonResourceCommand(
  projectDatabaseCommand
    .command("update")
    .description("Apply database configuration at the reviewed sequence"),
  schemas.updateClusterDatabase.input,
  (id, input) => getShipClient().projects.updateClusterDatabase(id, input),
  "Apply these database configuration changes?",
);
for (const [name, method] of [
  ["retry", "retryClusterDatabase"],
  ["backup", "backupClusterDatabase"],
] as const) {
  projectDatabaseCommand
    .command(name)
    .argument("<project>", "Project ID")
    .argument("<database>", "Database ID")
    .requiredOption("--sequence <number>", "Current database sequence", positiveInteger)
    .description(
      name === "retry"
        ? "Resume a failed database operation at its current sequence"
        : "Start a database backup at the reviewed sequence",
    )
    .action((id: string, databaseId: string, opts) =>
      printResult(() =>
        getShipClient().projects[method](id, { databaseId, expectedSequence: opts.sequence }),
      ),
    );
}
jsonResourceCommand(
  projectDatabaseCommand
    .command("connect")
    .description(
      "Bind a database to an environment key; null disconnects, replacement needs its sequence",
    ),
  schemas.connectClusterDatabase.input,
  (id, input) => getShipClient().projects.connectClusterDatabase(id, input),
);
jsonResourceCommand(
  projectDatabaseCommand
    .command("remove")
    .description("Remove a named database with an explicit retain-or-delete-data decision"),
  schemas.removeClusterDatabase.input,
  (id, input) => getShipClient().projects.removeClusterDatabase(id, input),
  "Remove this database with the selected data-retention policy?",
);

export const projectVolumeCommand = new Command("volume").description(
  "Manage replicated project volumes and recoverable backups",
);
projectVolumeCommand
  .command("list")
  .argument("<project>", "Project ID")
  .description("List volumes, resource versions and replica health")
  .action((id: string) => printResult(() => getShipClient().projects.listClusterVolumes(id)));
projectVolumeCommand
  .command("backups")
  .argument("<project>", "Project ID")
  .description("List volume backups available for recovery")
  .action((id: string) => printResult(() => getShipClient().projects.listClusterVolumeBackups(id)));
jsonResourceCommand(
  projectVolumeCommand
    .command("create")
    .description("Create a volume, optionally restored from a named backup"),
  schemas.createClusterVolume.input,
  (id, input) => getShipClient().projects.createClusterVolume(id, input),
);
jsonResourceCommand(
  projectVolumeCommand
    .command("resize")
    .description("Grow a volume using its exact resource version"),
  schemas.resizeClusterVolume.input,
  (id, input) => getShipClient().projects.resizeClusterVolume(id, input),
);
projectVolumeCommand
  .command("backup")
  .argument("<project>", "Project ID")
  .argument("<volume>", "Volume name")
  .requiredOption("--request-id <id>", "Stable request ID for this backup (16–64 characters)")
  .description("Create a volume backup with an idempotent request ID")
  .action((id: string, name: string, opts) =>
    printResult(() =>
      getShipClient().projects.backupClusterVolume(id, { name, requestId: opts.requestId }),
    ),
  );
jsonResourceCommand(
  projectVolumeCommand
    .command("schedule")
    .description("Set backup frequency and retention at a volume's current resource version"),
  schemas.scheduleClusterVolumeBackups.input,
  (id, input) => getShipClient().projects.scheduleClusterVolumeBackups(id, input),
);
jsonResourceCommand(
  projectVolumeCommand
    .command("remove-backup")
    .description("Delete a volume backup with explicit name confirmation"),
  schemas.removeClusterVolumeBackup.input,
  (id, input) => getShipClient().projects.removeClusterVolumeBackup(id, input),
  "Permanently delete this volume backup?",
);
jsonResourceCommand(
  projectVolumeCommand
    .command("remove")
    .description("Delete an unused volume and its data, checking its name and resource version"),
  schemas.removeClusterVolume.input,
  (id, input) => getShipClient().projects.removeClusterVolume(id, input),
  "Permanently delete this volume and its data?",
);
for (const [command, method] of [
  [projectVolumeCommand, "streamClusterVolumeEvents"],
  [projectDatabaseCommand, "streamClusterDatabaseEvents"],
] as const) {
  command
    .command("events")
    .argument("<project>", "Project ID")
    .description("Stream health and operation progress")
    .option("--timeout <ms>", "Stop after this deadline", timeoutMilliseconds)
    .action((id: string, opts) =>
      printEvents(
        getShipClient().projects[method](id, {
          signal: opts.timeout ? AbortSignal.timeout(opts.timeout) : undefined,
        }),
      ),
    );
}
