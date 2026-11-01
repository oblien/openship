import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { Command, Option } from "commander";
import {
  ServerResourceSchemas,
  ApplyServerContainerInputSchema,
  parseInput,
  isRecord,
} from "@repo/contracts";
import { getShipClient } from "../lib/ship-client";
import { readJsonInput, readSecret, timeoutMilliseconds } from "../lib/command-input";
import { confirmOrExit, printResult, fail } from "../lib/cmd-helpers";
import { printEvents } from "../lib/event-output";

export const serverGitHubCommand = new Command("github").description(
  "Manage GitHub credentials on a deployment server",
);
for (const [name, method, description] of [
  ["status", "githubStatus", "Read this server's GitHub connection and deploy keys"],
  ["connect", "connectGitHub", "Start device login; follow the returned verification URL and code"],
  ["poll", "pollGitHubConnection", "Check device login progress"],
  ["generate-key", "generateGitHubKey", "Generate a server key and print its public key"],
  ["deploy-keys", "useGitHubDeployKeys", "Use per-repository deploy keys for this server"],
] as const) {
  serverGitHubCommand
    .command(name)
    .argument("<server>", "Server ID")
    .description(description)
    .action((id: string) => printResult(() => getShipClient().servers[method](id)));
}
serverGitHubCommand
  .command("token")
  .argument("<server>", "Server ID")
  .argument("<file>", "Token file, or - for stdin")
  .description("Set the server's GitHub token without putting it in command arguments")
  .action((id: string, file: string) =>
    printResult(() => getShipClient().servers.setGitHubToken(id, { token: readSecret(file) })),
  );
serverGitHubCommand
  .command("disconnect")
  .argument("<server>", "Server ID")
  .option("-y, --yes", "Confirm credential removal")
  .description("Remove this server's GitHub connection")
  .action((id: string, opts) =>
    printResult(async () => {
      await confirmOrExit(opts.yes, `Disconnect GitHub from ${id}?`);
      return getShipClient().servers.disconnectGitHub(id);
    }),
  );

export const tunnelCommand = new Command("tunnel").description(
  "Manage tunnels opened on the selected Openship instance (not this CLI machine)",
);
tunnelCommand
  .command("list")
  .argument("<server>", "Server ID")
  .description("List saved tunnels and current listeners")
  .action((id: string) => printResult(() => getShipClient().servers.listTunnels(id)));
tunnelCommand
  .command("save")
  .argument("<server>", "Server ID")
  .argument(
    "<file>",
    "JSON remotePort, optional remoteHost, localPort and autoStart; - reads stdin",
  )
  .description("Save a tunnel configuration on the controller")
  .action((id: string, file: string) =>
    printResult(() =>
      getShipClient().servers.saveTunnel(
        id,
        parseInput(ServerResourceSchemas.saveTunnel.input, readJsonInput(file)),
      ),
    ),
  );
for (const [name, method] of [
  ["start", "startTunnel"],
  ["stop", "stopTunnel"],
  ["remove", "removeTunnel"],
] as const) {
  const command = tunnelCommand
    .command(name)
    .argument("<server>", "Server ID")
    .argument("<tunnel>", "Tunnel ID")
    .description(`${name} this tunnel on the controller`);
  if (name === "remove") command.option("-y, --yes", "Confirm tunnel removal");
  command.action((id: string, tunnelId: string, opts) =>
    printResult(async () => {
      if (name === "remove") await confirmOrExit(opts.yes, `Remove tunnel ${tunnelId} from ${id}?`);
      return getShipClient().servers[method](id, { tunnelId });
    }),
  );
}

export const containerCommand = new Command("containers").description(
  "Inspect and update infrastructure containers through the engine",
);
for (const [name, method, description] of [
  ["list", "listAllContainers", "List edge and mail containers across servers"],
  ["scan", "scanAllContainers", "Refresh infrastructure container state"],
  ["behind", "containersBehind", "Count outdated infrastructure containers"],
  ["issues", "containerIssues", "Show missing or stopped infrastructure containers"],
  ["active", "applyingContainers", "Show running and recently completed container updates"],
] as const) {
  containerCommand
    .command(name)
    .description(description)
    .action(() => printResult(() => getShipClient().servers[method]()));
}
for (const [name, method] of [
  ["get", "listContainers"],
  ["scan-server", "scanContainers"],
] as const) {
  containerCommand
    .command(name)
    .argument("<server>", "Server ID")
    .description(`${name === "get" ? "Read" : "Refresh"} a server's infrastructure containers`)
    .action((id: string) => printResult(() => getShipClient().servers[method](id)));
}
containerCommand
  .command("session")
  .argument("<server>", "Server ID")
  .argument("<component>", "edge | mail")
  .description("Find an in-progress update before retrying")
  .action((id: string, component: string) =>
    printResult(() =>
      getShipClient().servers.containerApplySession(
        id,
        parseInput(ServerResourceSchemas.containerApplySession.input, { component }),
      ),
    ),
  );
containerCommand
  .command("events")
  .argument("<server>", "Server ID")
  .argument("<component>", "edge | mail")
  .description("Reattach to update progress without starting another update")
  .option("--timeout <ms>", "Stop following after this deadline", timeoutMilliseconds)
  .action(async (id: string, component: string, opts) => {
    try {
      const input = parseInput(ServerResourceSchemas.containerApplySession.input, { component });
      await printEvents(
        getShipClient().servers.containerApplyEvents(id, input, {
          signal: opts.timeout ? AbortSignal.timeout(opts.timeout) : undefined,
        }),
      );
    } catch (error) {
      observeCaughtError(error, "cli/commands/server-integrations");
      fail(error);
    }
  });
containerCommand
  .command("apply")
  .argument("<server>", "Server ID")
  .argument("<component>", "edge | mail")
  .addOption(
    new Option("--intent <intent>", "Operation to apply")
      .choices(["update", "repair"])
      .default("update"),
  )
  .option("--timeout <ms>", "Stop following after this deadline", timeoutMilliseconds)
  .option("-y, --yes", "Confirm the container restart")
  .description("Apply an infrastructure update and follow its existing engine session")
  .action(async (id: string, component: string, opts) => {
    try {
      const input = parseInput(ApplyServerContainerInputSchema, { component, intent: opts.intent });
      await confirmOrExit(opts.yes, `${opts.intent} ${component} on ${id}?`);
      await printEvents(
        getShipClient().servers.applyContainer(id, input, {
          signal: opts.timeout ? AbortSignal.timeout(opts.timeout) : undefined,
        }),
        {
          event: "complete",
          successful: (data) => isRecord(data) && data.status === "completed",
        },
      );
    } catch (error) {
      observeCaughtError(error, "cli/commands/server-integrations");
      fail(error);
    }
  });
containerCommand
  .command("apply-all")
  .description("Queue eligible infrastructure updates; use active to inspect completion")
  .addOption(
    new Option("--intent <intent>", "Limit queued work to this intent").choices([
      "update",
      "repair",
    ]),
  )
  .option("-y, --yes", "Confirm restarts across eligible servers")
  .action((opts) =>
    printResult(async () => {
      await confirmOrExit(
        opts.yes,
        "Queue infrastructure container changes across eligible servers?",
      );
      return getShipClient().servers.applyAllContainers({
        intents: opts.intent ? [opts.intent] : undefined,
      });
    }),
  );
