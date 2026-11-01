import { Command } from "commander";
import { clearToken, getActiveContext, readConfig, usesEnvironmentToken } from "../lib/config";
import { info, isJsonMode, ok, printJson } from "../lib/output";

export const logoutCommand = new Command("logout")
  .description("Remove the stored Openship token")
  .option("--context <name>", "Log out of a specific context (defaults to active)")
  .action((opts) => {
    const name: string = opts.context || getActiveContext();
    const config = readConfig();
    const removed = Object.hasOwn(config.contexts, name) && Boolean(config.contexts[name].token);
    if (removed) clearToken(name);
    const environmentToken = usesEnvironmentToken(name);
    if (isJsonMode()) printJson({ authenticated: environmentToken, context: name, removed,
      ...(environmentToken ? { credentialSource: "environment" } : {}) });
    else if (environmentToken) info(`Stored token removed for "${name}". OPENSHIP_TOKEN is still active; unset it in your shell to sign out.`);
    else if (removed) ok(`Logged out (context "${name}").`);
    else info(`Not logged in (context "${name}").`);
  });
