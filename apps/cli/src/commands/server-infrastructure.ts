import { Command, Option } from "commander";
import { ServerCollectionSchemas as schemas, parseInput } from "@repo/contracts";
import { getShipClient } from "../lib/ship-client";
import { positiveInteger, timeoutMilliseconds } from "../lib/command-input";
import { confirmOrExit, printResult } from "../lib/cmd-helpers";
import { jsonCommand } from "../lib/json-command";
import { printEvents } from "../lib/event-output";

export const networkCommand = new Command("network").description(
  "Manage private networks and reviewed network operations",
);
networkCommand
  .command("capabilities")
  .description("Show network providers and available operations")
  .action(() => printResult(() => getShipClient().servers.networkCapabilities()));
networkCommand
  .command("list")
  .description("List private networks")
  .action(() => printResult(() => getShipClient().servers.listNetworks()));
networkCommand
  .command("get")
  .argument("<id>", "Network ID")
  .description("Read network members, revision and verification")
  .action((networkId: string) =>
    printResult(() => getShipClient().servers.getNetwork({ networkId })),
  );
networkCommand
  .command("inspect-host")
  .argument("<server>", "Server ID")
  .description("Inspect a server's interfaces and network readiness")
  .action((id: string) => printResult(() => getShipClient().servers.inspectNetwork(id)));
jsonCommand(
  networkCommand
    .command("create")
    .description("Register a private network and its existing host interfaces"),
  schemas.createNetwork.input,
  (input) => getShipClient().servers.createNetwork(input),
);
jsonCommand(
  networkCommand.command("update").description("Update a network using its exact current revision"),
  schemas.updateNetwork.input,
  (input) => getShipClient().servers.updateNetwork(input),
  "Apply this private-network configuration?",
);
jsonCommand(
  networkCommand
    .command("verify")
    .description("Verify connectivity and optional throughput at a saved revision"),
  schemas.verifyNetwork.input,
  (input) => getShipClient().servers.verifyNetwork(input),
);
networkCommand
  .command("remove")
  .argument("<id>", "Network ID")
  .requiredOption("--revision <number>", "Revision from network get", positiveInteger)
  .option("-y, --yes", "Confirm removal")
  .description("Remove this network if its current state permits it")
  .action((networkId: string, opts) =>
    printResult(async () => {
      const input = parseInput(schemas.removeNetwork.input, { networkId, revision: opts.revision });
      await confirmOrExit(opts.yes, `Remove private network ${networkId}?`);
      return getShipClient().servers.removeNetwork(input);
    }),
  );
networkCommand
  .command("events")
  .description("Stream changes to private networks")
  .option("--timeout <ms>", "Stop after this deadline", timeoutMilliseconds)
  .action((opts) =>
    printEvents(
      getShipClient().servers.clusterEvents({
        signal: opts.timeout ? AbortSignal.timeout(opts.timeout) : undefined,
      }),
    ),
  );

const preparation = new Command("preparation").description(
  "Prepare managed networking and recover interrupted preparation",
);
preparation
  .command("list")
  .description("List in-progress and recoverable preparations")
  .action(() => printResult(() => getShipClient().servers.listManagedNetworkPreparations()));
preparation
  .command("get")
  .argument("<id>", "Preparation ID")
  .description("Read preparation steps, access policy and sequence")
  .action((preparationId: string) =>
    printResult(() => getShipClient().servers.getManagedNetworkPreparation({ preparationId })),
  );
jsonCommand(
  preparation.command("create").description("Start an idempotent managed-network preparation"),
  schemas.prepareManagedNetwork.input,
  (input) => getShipClient().servers.prepareManagedNetwork(input),
);
jsonCommand(
  preparation.command("access").description("Revise a preparation's reviewed access policy"),
  schemas.reviseManagedNetworkAccess.input,
  (input) => getShipClient().servers.reviseManagedNetworkAccess(input),
  "Change access for this network preparation?",
);
jsonCommand(
  preparation
    .command("remove-member")
    .description("Remove a host from a preparation using its exact sequence"),
  schemas.removeManagedNetworkPreparationMember.input,
  (input) => getShipClient().servers.removeManagedNetworkPreparationMember(input),
  "Remove this host from the network preparation?",
);
jsonCommand(
  preparation
    .command("discard")
    .description("Discard the selected preparation at its current sequence"),
  schemas.discardManagedNetworkPreparation.input,
  (input) => getShipClient().servers.discardManagedNetworkPreparation(input),
  "Discard this network preparation?",
);
preparation
  .command("events")
  .argument("<id>", "Preparation ID")
  .description("Stream preparation progress")
  .option("--timeout <ms>", "Stop after this deadline", timeoutMilliseconds)
  .action((id: string, opts) =>
    printEvents(
      getShipClient().servers.managedNetworkPreparationEvents(id, {
        signal: opts.timeout ? AbortSignal.timeout(opts.timeout) : undefined,
      }),
    ),
  );
networkCommand.addCommand(preparation);

const operation = new Command("operation").description(
  "Review and execute an exact managed-network plan",
);
jsonCommand(
  operation
    .command("plan")
    .description("Plan managed-network configuration or removal with an idempotent request ID"),
  schemas.planManagedNetwork.input,
  (input) => getShipClient().servers.planManagedNetwork(input),
);
operation
  .command("get")
  .argument("<id>", "Operation ID")
  .description("Read a plan, its hash and execution progress")
  .action((operationId: string) =>
    printResult(() => getShipClient().servers.getManagedNetworkOperation({ operationId })),
  );
operation
  .command("apply")
  .argument("<id>", "Operation ID")
  .requiredOption("--plan-hash <hash>", "Exact hash of the plan you reviewed")
  .addOption(
    new Option("--action <action>", "Execution action")
      .choices(["apply", "resume", "rollback"])
      .default("apply"),
  )
  .option("-y, --yes", "Confirm this plan's host changes")
  .description("Apply, resume or roll back a reviewed plan without rebuilding it")
  .action((operationId: string, opts) =>
    printResult(async () => {
      const input = parseInput(schemas.applyManagedNetwork.input, {
        operationId,
        planHash: opts.planHash,
        action: opts.action,
      });
      await confirmOrExit(opts.yes, `${opts.action} managed-network operation ${operationId}?`);
      return getShipClient().servers.applyManagedNetwork(input);
    }),
  );
jsonCommand(
  operation.command("discard").description("Discard a plan using its exact hash"),
  schemas.discardManagedNetworkPlan.input,
  (input) => getShipClient().servers.discardManagedNetworkPlan(input),
  "Discard this network plan?",
);
jsonCommand(
  operation
    .command("remove-member")
    .description("Remove a host using the operation's exact plan hash and sequence"),
  schemas.removeManagedNetworkOperationMember.input,
  (input) => getShipClient().servers.removeManagedNetworkOperationMember(input),
  "Remove this host from the network operation?",
);
operation
  .command("events")
  .argument("<id>", "Operation ID")
  .description("Stream plan execution and recovery progress")
  .option("--timeout <ms>", "Stop after this deadline", timeoutMilliseconds)
  .action((id: string, opts) =>
    printEvents(
      getShipClient().servers.managedNetworkOperationEvents(id, {
        signal: opts.timeout ? AbortSignal.timeout(opts.timeout) : undefined,
      }),
    ),
  );
networkCommand.addCommand(operation);

export const clusterCommand = new Command("cluster").description(
  "Manage compute clusters, scaling runtimes and replicated storage",
);
clusterCommand
  .command("list")
  .description("List compute clusters")
  .action(() => printResult(() => getShipClient().servers.listComputeClusters()));
clusterCommand
  .command("get")
  .argument("<id>", "Compute cluster ID")
  .description("Read cluster members and scaling readiness")
  .action((clusterId: string) =>
    printResult(() => getShipClient().servers.getComputeCluster({ clusterId })),
  );
jsonCommand(
  clusterCommand
    .command("create")
    .description("Create a compute cluster on an existing private network"),
  schemas.createComputeCluster.input,
  (input) => getShipClient().servers.createComputeCluster(input),
);
jsonCommand(
  clusterCommand.command("update").description("Change cluster members at the reviewed revision"),
  schemas.updateComputeCluster.input,
  (input) => getShipClient().servers.updateComputeCluster(input),
  "Change this compute cluster's configuration?",
);
clusterCommand
  .command("remove")
  .argument("<id>", "Compute cluster ID")
  .requiredOption("--revision <number>", "Revision from cluster get", positiveInteger)
  .option("-y, --yes", "Confirm cluster removal")
  .description("Remove an unused compute cluster at its current revision")
  .action((clusterId: string, opts) =>
    printResult(async () => {
      const input = parseInput(schemas.removeComputeCluster.input, {
        clusterId,
        revision: opts.revision,
      });
      await confirmOrExit(opts.yes, `Remove compute cluster ${clusterId}?`);
      return getShipClient().servers.removeComputeCluster(input);
    }),
  );

const runtime = new Command("runtime").description("Install or recover the shared scaling runtime");
runtime
  .command("get")
  .argument("<id>", "Compute cluster ID")
  .description("Read runtime status and sequence")
  .action((clusterId: string) =>
    printResult(() => getShipClient().servers.getClusterRuntime({ clusterId })),
  );
jsonCommand(
  runtime
    .command("setup")
    .description("Install the runtime using a reviewed cluster revision and request ID"),
  schemas.setupClusterRuntime.input,
  (input) => getShipClient().servers.setupClusterRuntime(input),
  "Install the runtime on this cluster's hosts?",
);
for (const [name, method] of [
  ["retry", "retryClusterRuntime"],
  ["remove", "removeClusterRuntime"],
] as const) {
  runtime
    .command(name)
    .argument("<id>", "Compute cluster ID")
    .requiredOption("--sequence <number>", "Current sequence from runtime get", positiveInteger)
    .option("-y, --yes", "Confirm host changes")
    .description(`${name} the runtime at the reviewed sequence`)
    .action((clusterId: string, opts) =>
      printResult(async () => {
        await confirmOrExit(opts.yes, `${name} the runtime for ${clusterId}?`);
        return getShipClient().servers[method]({ clusterId, sequence: opts.sequence });
      }),
    );
}
runtime
  .command("events")
  .argument("<id>", "Compute cluster ID")
  .description("Stream runtime progress")
  .option("--timeout <ms>", "Stop after this deadline", timeoutMilliseconds)
  .action((id: string, opts) =>
    printEvents(
      getShipClient().servers.clusterRuntimeEvents(id, {
        signal: opts.timeout ? AbortSignal.timeout(opts.timeout) : undefined,
      }),
    ),
  );
clusterCommand.addCommand(runtime);

const storage = new Command("storage").description(
  "Manage replicated cluster storage and its backup destination",
);
storage
  .command("get")
  .argument("<id>", "Compute cluster ID")
  .option("--observe", "Refresh storage health from the cluster")
  .description("Read storage status, disks and current sequence")
  .action((clusterId: string, opts) =>
    printResult(() =>
      getShipClient().servers.getClusterStorage({ clusterId, observe: opts.observe }),
    ),
  );
jsonCommand(
  storage
    .command("setup")
    .description("Configure replicated storage with explicit disks and capacity reservations"),
  schemas.setupClusterStorage.input,
  (input) => getShipClient().servers.setupClusterStorage(input),
  "Configure storage on these cluster disks?",
);
for (const [name, method] of [
  ["retry", "retryClusterStorage"],
  ["remove", "removeClusterStorage"],
] as const) {
  storage
    .command(name)
    .argument("<id>", "Compute cluster ID")
    .requiredOption("--sequence <number>", "Current sequence from storage get", positiveInteger)
    .option("-y, --yes", "Confirm storage changes")
    .description(`${name} storage at the reviewed sequence`)
    .action((clusterId: string, opts) =>
      printResult(async () => {
        await confirmOrExit(opts.yes, `${name} storage for ${clusterId}?`);
        return getShipClient().servers[method]({ clusterId, sequence: opts.sequence });
      }),
    );
}
storage
  .command("backup")
  .argument("<id>", "Compute cluster ID")
  .argument("<destination>", "Backup destination ID")
  .requiredOption("--sequence <number>", "Current sequence from storage get", positiveInteger)
  .description("Set the storage backup destination at its current sequence")
  .action((clusterId: string, destinationId: string, opts) =>
    printResult(() =>
      getShipClient().servers.configureClusterStorageBackup({
        clusterId,
        destinationId,
        sequence: opts.sequence,
      }),
    ),
  );
storage
  .command("events")
  .argument("<id>", "Compute cluster ID")
  .description("Stream storage progress")
  .option("--timeout <ms>", "Stop after this deadline", timeoutMilliseconds)
  .action((id: string, opts) =>
    printEvents(
      getShipClient().servers.clusterStorageEvents(id, {
        signal: opts.timeout ? AbortSignal.timeout(opts.timeout) : undefined,
      }),
    ),
  );
clusterCommand.addCommand(storage);
