/** Project administration uses the same contracts and operations as deploy and the dashboard. */
import { Command, Option } from "commander";
import {
  UpdateProjectBody, UpdateResourcesBody, CreateProjectEnvironmentBody,
  ProjectControlSchemas, parseInput,
  ImportLocalProjectBody,
} from "@repo/contracts";
import { getShipClient } from "../lib/ship-client";
import { readJsonInput, positiveInteger, readSecret, timeoutMilliseconds } from "../lib/command-input";
import { confirmOrExit, printResult } from "../lib/cmd-helpers";
import { jsonCommand, jsonResourceCommand } from "../lib/json-command";
import { printEvents } from "../lib/event-output";

export const projectUpdateCommand = new Command("update")
  .description("Patch a project's build and runtime configuration")
  .argument("<id>", "Project ID")
  .argument("<file>", "JSON patch using the shared project update contract")
  .action((id: string, file: string) => printResult(() =>
    getShipClient().projects.update(id, parseInput(UpdateProjectBody, readJsonInput(file)))));

export const projectEnvironmentCommand = new Command("environment")
  .alias("environments")
  .description("Manage isolated project environments (each has its own project ID)");
projectEnvironmentCommand.command("list").alias("ls")
  .description("List this project's environments and their project IDs")
  .argument("<id>", "Project ID")
  .action((id: string) => printResult(() => getShipClient().projects.listEnvironments(id)));
projectEnvironmentCommand.command("create")
  .description("Create an isolated environment; deploy and link the returned project ID")
  .argument("<id>", "Source project ID")
  .argument("<name>", "Environment name")
  .option("--slug <slug>", "Environment slug")
  .option("--type <type>", "production | preview | development", "preview")
  .option("--branch <branch>", "Git branch for the environment")
  .addOption(new Option("--source-mode <mode>", "How this environment tracks source").choices(["branch", "manual"]))
  .action((id: string, name: string, opts) => printResult(() => getShipClient().projects.createEnvironment(id,
    parseInput(CreateProjectEnvironmentBody, {
      environmentName: name, environmentSlug: opts.slug, environmentType: opts.type,
      gitBranch: opts.branch, sourceMode: opts.sourceMode,
    }))));

export const projectResourcesCommand = new Command("resources")
  .description("Inspect and configure project CPU, memory, disk and build limits");
projectResourcesCommand.command("get").argument("<id>", "Project ID")
  .description("Show limits and available capacity from the engine")
  .action((id: string) => printResult(() => getShipClient().projects.getResources(id)));
projectResourcesCommand.command("set").argument("<id>", "Project ID")
  .argument("<file>", "JSON patch with production/build resource selections, sleepMode or port")
  .description("Change resource limits; the engine enforces destination capacity and Cloud policy")
  .action((id: string, file: string) => printResult(() =>
    getShipClient().projects.updateResources(id, parseInput(UpdateResourcesBody, readJsonInput(file)))));

export const projectStorageCommand = new Command("storage")
  .description("Inspect storage and bind an app's object storage connection");
projectStorageCommand.command("get").argument("<id>", "Project ID")
  .description("Show the storage binding, volumes and available providers")
  .action((id: string) => printResult(() => getShipClient().projects.getStorage(id)));
projectStorageCommand.command("bind").argument("<id>", "Project ID")
  .argument("<file>", "JSON storage binding: bucket and sourceProjectId, or external provider credentials")
  .description("Save an object storage binding; redeploy to apply its variables")
  .action((id: string, file: string) => printResult(() => getShipClient().projects.bindStorage(id,
    parseInput(ProjectControlSchemas.bindStorage.input, readJsonInput(file)))));
projectStorageCommand.command("unbind").argument("<id>", "Project ID")
  .description("Remove the object's storage binding from this project")
  .option("-y, --yes", "Skip confirmation")
  .action((id: string, opts) => printResult(async () => {
    await confirmOrExit(opts.yes, `Remove the storage binding from ${id}?`);
    return getShipClient().projects.unbindStorage(id);
  }));

export const projectConnectionsCommand = new Command("connections")
  .description("Wire app outputs into a project's environment through the engine");
for (const [name, method, description] of [
  ["list", "listConnections", "List this project's incoming app connections"],
  ["candidates", "listConnectionCandidates", "List apps that can supply connection outputs"],
  ["consumers", "listConnectionConsumers", "List projects consuming this project's outputs"],
] as const) {
  projectConnectionsCommand.command(name).argument("<id>", "Project ID").description(description)
    .action((id: string) => printResult(() => getShipClient().projects[method](id)));
}
projectConnectionsCommand.command("create").argument("<id>", "Target project ID")
  .argument("<file>", "JSON connection with sourceProjectId, outputId, envKey and optional mode")
  .description("Connect one app output; redeploy to apply it")
  .action((id: string, file: string) => printResult(() => getShipClient().projects.createConnection(id,
    parseInput(ProjectControlSchemas.createConnection.input, readJsonInput(file)))));
projectConnectionsCommand.command("bundle").argument("<id>", "Target project ID")
  .argument("<file>", "JSON connection bundle with sourceProjectId and items")
  .description("Connect several app outputs atomically; redeploy to apply them")
  .action((id: string, file: string) => printResult(() => getShipClient().projects.connectBundle(id,
    parseInput(ProjectControlSchemas.connectBundle.input, readJsonInput(file)))));
projectConnectionsCommand.command("remove").alias("rm")
  .argument("<id>", "Target project ID").argument("<connection>", "Connection ID")
  .description("Remove an app connection")
  .option("-y, --yes", "Skip confirmation")
  .action((id: string, connection: string, opts) => printResult(async () => {
    await confirmOrExit(opts.yes, `Remove connection ${connection} from ${id}?`);
    return getShipClient().projects.removeConnection(id, connection);
  }));

export const projectInspectionCommands = ([
  ["pending", "getPendingActions", "Show pending deployment, routing and certificate actions"],
  ["incidents", "getIncidents", "Show this project's monitoring incidents"],
  ["role-config", "getRuntimeRoleConfiguration", "Read editable runtime role settings from the active Docker release"],
  ["roles", "getRuntimeRoles", "Show active runtime roles, replicas, status and restart counts"],
  ["drift", "getCommitStatus", "Compare source and deployment configuration"],
  ["rollback-capacity", "getRollbackCapacity", "Inspect retained rollback capacity"],
  ["info", "getInfo", "Read project details and deployment configuration"],
  ["git-info", "getGitInfo", "Read the configured repository and source state"],
  ["session", "deploymentSession", "Find this project's active deployment session"],
  ["check-ports", "checkPorts", "Probe configured service ports on the deployment destination"],
  ["check-output", "checkOutput", "Inspect deployed static output on its actual destination"],
  ["edge-config", "getEdgeConfig", "Read effective edge routing configuration"],
] as const).map(([name, method, description]) => new Command(name).argument("<id>", "Project ID")
  .description(description).action((id: string) => printResult(() => getShipClient().projects[method](id))));

export const projectOptionsCommand = jsonResourceCommand(new Command("options").description("Change supported project options using the shared input schema"),
  ProjectControlSchemas.setOptions.input, (id, input) => getShipClient().projects.setOptions(id, input));
export const projectCacheCommand = new Command("clear-build-cache").argument("<id>", "Project ID")
  .option("-y, --yes", "Confirm clearing the destination's shared build cache")
  .description("Clear the host build cache used by this project; other projects on that host share it")
  .action((id: string, opts) => printResult(async () => {
    await confirmOrExit(opts.yes, `Clear the shared host build cache used by ${id}?`);
    return getShipClient().projects.clearBuildCache(id);
  }));
export const projectDeploymentsCommand = new Command("deployments").argument("<id>", "Project ID")
  .option("--page <number>", "Page number", positiveInteger)
  .option("--limit <number>", "Page size", positiveInteger)
  .option("--environment <name>", "Environment filter").option("--status <status>", "Deployment status")
  .option("--search <text>", "Search deployments")
  .description("Read full project deployment records with pagination")
  .action((id: string, opts) => printResult(() => getShipClient().projects.listDeployments(id,
    parseInput(ProjectControlSchemas.listDeployments.input, { page: opts.page, perPage: opts.limit, environment: opts.environment, status: opts.status, search: opts.search }))));

export const projectCloneCommand = new Command("clone-token").description("Manage this project's explicit clone credential");
projectCloneCommand.command("get").argument("<id>", "Project ID").description("Read credential presence without revealing its value")
  .action((id: string) => printResult(() => getShipClient().projects.getCloneToken(id)));
projectCloneCommand.command("set").argument("<id>", "Project ID").argument("<file>", "Token file, or - for stdin")
  .description("Save a project-specific clone token")
  .action((id: string, file: string) => printResult(() => getShipClient().projects.updateCloneToken(id, { token: readSecret(file) })));
projectCloneCommand.command("clear").argument("<id>", "Project ID").description("Remove this project's explicit clone token")
  .action((id: string) => printResult(() => getShipClient().projects.updateCloneToken(id, { token: null })));

export const projectLocalCommand = new Command("local").description("Manage folders on the Openship instance; use deploy --folder for this machine's files");
projectLocalCommand.command("list").description("List projects linked to folders on the controller")
  .action(() => printResult(() => getShipClient().projects.listLocal()));
projectLocalCommand.command("scan").argument("<path>", "Absolute path on the controller")
  .description("Inspect a folder accessible to the self-hosted controller")
  .action((path: string) => printResult(() => getShipClient().projects.scanLocal({ path })));
jsonCommand(projectLocalCommand.command("import").description("Register a folder on the controller as a project"),
  ImportLocalProjectBody, input => getShipClient().projects.importLocal(input));

export const projectRoutingCommand = new Command("routing").description("Manage project routing rules and retry route synchronization");
const routeProtection = projectRoutingCommand.command("protection")
  .description("Protect self-hosted HTTPS hostnames with an edge password");
routeProtection.command("list").argument("<id>", "Project ID")
  .description("Read protection status without credentials")
  .action((id: string) => printResult(() => getShipClient().projects.listRouteProtection(id)));
routeProtection.command("protect").argument("<id>", "Project ID").argument("<hostname>", "Exact custom hostname")
  .requiredOption("--password-file <file>", "Password file, or - for stdin (never a command-line password)")
  .description("Set or change the password; existing browser sessions expire")
  .action((id: string, hostname: string, opts) => printResult(() =>
    getShipClient().projects.changeRouteProtection(id, { hostname, action: "protect", password: readSecret(opts.passwordFile, { preserveWhitespace: true }) })));
for (const action of ["retry", "revoke", "unlock"] as const) {
  routeProtection.command(action).argument("<id>", "Project ID").argument("<hostname>", "Exact custom hostname")
    .option("-y, --yes", "Confirm making the hostname public (unlock only)")
    .description({ retry: "Retry the saved edge update", revoke: "Sign out all browsers", unlock: "Remove password protection and make this hostname public" }[action])
    .action((id: string, hostname: string, opts) => printResult(async () => {
      if (action === "unlock") await confirmOrExit(opts.yes, `Make ${hostname} public without a password?`);
      return getShipClient().projects.changeRouteProtection(id, { hostname, action });
    }));
}
projectRoutingCommand.command("list").argument("<id>", "Project ID").description("Read saved routing rules")
  .action((id: string) => printResult(() => getShipClient().projects.listRouteRules(id)));
jsonResourceCommand(projectRoutingCommand.command("create").description("Create a project or domain routing rule"),
  ProjectControlSchemas.createRouteRule.input, (id, input) => getShipClient().projects.createRouteRule(id, input));
jsonResourceCommand(projectRoutingCommand.command("update").description("Update a named routing rule through the shared edge sanitizer"),
  ProjectControlSchemas.updateRouteRule.input, (id, input) => getShipClient().projects.updateRouteRule(id, input));
projectRoutingCommand.command("remove").argument("<id>", "Project ID").argument("<rule>", "Rule ID")
  .option("-y, --yes", "Confirm rule removal").description("Remove one routing rule")
  .action((id: string, rule: string, opts) => printResult(async () => {
    await confirmOrExit(opts.yes, `Remove routing rule ${rule} from ${id}?`);
    return getShipClient().projects.removeRouteRule(id, rule);
  }));
projectRoutingCommand.command("retry").argument("<id>", "Project ID")
  .option("--follow", "Stream route and certificate progress")
  .option("--timeout <ms>", "Stop following after this deadline", timeoutMilliseconds)
  .description("Retry the existing project routing workflow")
  .action(async (id: string, opts) => {
    if (opts.follow) return printEvents(getShipClient().projects.retryRoutingStream(id, { signal: opts.timeout ? AbortSignal.timeout(opts.timeout) : undefined }));
    await printResult(async () => {
      const result = await getShipClient().projects.retryRouting(id);
      if (!result.ok) process.exitCode = 1;
      return result;
    });
  });

export const projectRoleConfigurationCommand = jsonResourceCommand(new Command("configure-roles").description("Apply runtime roles using the active image, preserving web and unchanged replicas"),
  ProjectControlSchemas.configureRuntimeRoles.input, (id, input) => getShipClient().projects.configureRuntimeRoles(id, input));
