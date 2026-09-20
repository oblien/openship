/** Catalog and app commands are presentation over the native/remote SDK. */
import { Command } from "commander";
import { readFile } from "node:fs/promises";
import type { AppOperations, InstallAppInput, ProjectOperations } from "@repo/sdk";
import { getShipClient } from "../lib/ship-client";
import { fail } from "../lib/cmd-helpers";
import { printJson, printTable } from "../lib/output";

async function inputFile<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8"));
}
async function data(work: () => Promise<unknown>): Promise<void> {
  try { printJson(await work()); }
  catch (error) { fail(error); }
}

export const appCommand = new Command("app").description("Browse, install, and configure catalog apps");

appCommand.addCommand(new Command("list").aliases(["ls", "catalog"])
  .description("List available catalog apps")
  .action(async () => {
    try { printTable(await getShipClient().apps.listCatalog(), ["id", "name", "category", "verified", "comingSoon"]); }
    catch (error) { fail(error); }
  }));
appCommand.addCommand(new Command("get").argument("<id>", "Catalog app ID")
  .description("Show an app template and an accessible installation draft")
  .action((id: string) => data(() => getShipClient().apps.getCatalogEntry(id))));
appCommand.addCommand(new Command("host-fit").argument("<id>", "Catalog app ID")
  .description("Check an app's requirements against a deployment destination")
  .option("--server <id>", "Registered server ID")
  .option("--target <target>", "Deployment target, such as cloud")
  .action((id: string, options: { server?: string; target?: string }) => data(() => getShipClient().apps.hostFit(id, { serverId: options.server, deployTarget: options.target }))));
appCommand.addCommand(new Command("install").argument("<id>", "Catalog app ID")
  .description("Create or update an app installation draft; deploy its returned project ID with openship deploy")
  .option("--name <name>", "Project name")
  .option("--config <file>", "JSON object of app configuration values")
  .option("--routes <file>", "JSON array of endpoint routing choices")
  .action((id: string, options: { name?: string; config?: string; routes?: string }) => data(async () => {
    const input: InstallAppInput = { templateId: id, name: options.name };
    if (options.config) input.config = await inputFile(options.config);
    if (options.routes) input.routes = await inputFile(options.routes);
    return getShipClient().apps.install(input);
  })));

const custom = new Command("custom").description("Manage this organization's custom app definitions");
custom.addCommand(new Command("list").alias("ls").action(async () => {
  try { printTable(await getShipClient().apps.listCustom(), ["appId", "name", "updatedAt"]); }
  catch (error) { fail(error); }
}));
custom.addCommand(new Command("add").argument("<file>", "AppTemplate JSON file")
  .description("Validate and save a custom app definition")
  .action((file: string) => data(async () => getShipClient().apps.saveCustom(await inputFile<Parameters<AppOperations["saveCustom"]>[0]>(file)))));
custom.addCommand(new Command("remove").alias("rm").argument("<id>", "Custom app ID")
  .description("Remove a custom catalog definition")
  .action((id: string) => data(() => getShipClient().apps.removeCustom(id))));
appCommand.addCommand(custom);

const settings = new Command("settings").description("Read and update an installed app's curated settings");
settings.addCommand(new Command("get").argument("<project>", "Installed app project ID")
  .action((project: string) => data(() => getShipClient().projects.getAppSettings(project))));
settings.addCommand(new Command("update").argument("<project>", "Installed app project ID")
  .argument("<file>", "JSON object containing a changes array of {service, key, value}")
  .action((project: string, file: string) => data(async () => getShipClient().projects.updateAppSettings(project,
    await inputFile<Parameters<ProjectOperations["updateAppSettings"]>[1]>(file)))));
appCommand.addCommand(settings);
appCommand.addCommand(new Command("connection").argument("<project>", "Installed app project ID")
  .description("Show resolved app connection details, including credentials; requires project write access")
  .action((project: string) => data(() => getShipClient().projects.getAppConnection(project))));
