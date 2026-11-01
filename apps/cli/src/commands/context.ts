/**
 * `openship context` — manage the named connection contexts in
 * ~/.openship/config.json (see lib/config.ts). Each context pins an
 * API + dashboard endpoint and its PAT; `current` selects the active one that
 * every authenticated command reads from.
 *
 * Pure config CRUD — no API calls. `add` here only stores endpoints/token;
 * `openship login` is still the way to validate a token before saving it.
 */
import { Command } from "commander";
import {
  addContext,
  getActiveContext,
  listContexts,
  removeContext,
  setActiveContext,
} from "../lib/config";
import { err, ok, printTable } from "../lib/output";
import { reportResult } from "../lib/cmd-helpers";

function renderContexts(): void {
  const rows = listContexts().map((c) => ({
    current: c.current ? "*" : "",
    name: c.name,
    apiUrl: c.apiUrl,
    dashboardUrl: c.dashboardUrl,
    organization: c.organizationId ?? "",
    auth: c.hasToken ? "token" : "-",
  }));
  printTable(rows, ["current", "name", "apiUrl", "dashboardUrl", "organization", "auth"]);
}

const listCmd = new Command("list")
  .alias("ls")
  .description("List configured contexts")
  .action(renderContexts);

const useCmd = new Command("use")
  .description("Switch the active context")
  .argument("<name>", "Context name")
  .action((name: string) => {
    try {
      setActiveContext(name);
      reportResult({ context: name, active: true }, `Active context → ${name}`);
    } catch (e) {
      err((e as Error).message);
      process.exit(1);
    }
  });

const addCmd = new Command("add")
  .description("Create or update a context's endpoints/token")
  .argument("<name>", "Context name")
  .option("--api-url <url>", "API base URL")
  .option("--dashboard-url <url>", "Dashboard base URL")
  .option("--token <token>", "Personal Access Token to store")
  .option("--organization <id>", "Pin this context to a Cloud or self-hosted organization")
  .option("--use", "Switch to this context after adding")
  .action((name: string, opts) => {
    addContext(name, {
      apiUrl: opts.apiUrl,
      dashboardUrl: opts.dashboardUrl,
      token: opts.token,
      organizationId: opts.organization,
    });
    if (opts.use) setActiveContext(name);
    reportResult({ context: name, saved: true, active: listContexts().find(context => context.name === name)?.current ?? false }, `Saved context "${name}"${opts.use ? " (now active)" : ""}.`);
  });

const rmCmd = new Command("rm")
  .alias("remove")
  .description("Remove a context (cannot remove the active one)")
  .argument("<name>", "Context name")
  .action((name: string) => {
    try {
      removeContext(name);
      reportResult({ context: name, removed: true }, `Removed context "${name}".`);
    } catch (e) {
      err((e as Error).message);
      process.exit(1);
    }
  });

export const contextCommand = new Command("context")
  .alias("ctx")
  .description("Manage connection contexts (list/use/add/rm)")
  .action(() => {
    // Bare `openship context` → show the list (active row is starred).
    ok(`  Active context: ${getActiveContext()}`);
    renderContexts();
  })
  .addCommand(listCmd)
  .addCommand(useCmd)
  .addCommand(addCmd)
  .addCommand(rmCmd);
