import { Command } from "commander";
import { CreateCredentialBody, UpdateCredentialBody, parseInput } from "@repo/contracts";
import { getShipClient } from "../lib/ship-client";
import { readJsonInput } from "../lib/command-input";
import { confirmOrExit, printResult } from "../lib/cmd-helpers";

export const credentialCommand = new Command("credential").alias("credentials")
  .description("Manage stored registry and DNS credentials; reads return masked secrets");
credentialCommand.command("providers").description("Show supported providers and their required fields")
  .action(() => printResult(() => getShipClient().credentials.listProviders()));
credentialCommand.command("list").alias("ls").description("List stored credentials")
  .action(() => printResult(() => getShipClient().credentials.list()));
credentialCommand.command("get").argument("<id>", "Credential ID").description("Show one credential with secrets masked")
  .action((id: string) => printResult(() => getShipClient().credentials.get(id)));
credentialCommand.command("create").argument("<file>", "JSON object with provider, name, optional selector and values")
  .description("Create a credential; required provider fields are validated by the engine")
  .action((file: string) => printResult(() => getShipClient().credentials.create(parseInput(CreateCredentialBody, readJsonInput(file)))));
credentialCommand.command("update").argument("<id>", "Credential ID").argument("<file>", "JSON credential patch")
  .description("Update selected credential fields without echoing secrets")
  .action((id: string, file: string) => printResult(() => getShipClient().credentials.update(id, parseInput(UpdateCredentialBody, readJsonInput(file)))));
credentialCommand.command("verify").argument("<id>", "Credential ID").description("Verify a credential against its provider")
  .action((id: string) => printResult(async () => {
    const result = await getShipClient().credentials.verify(id);
    if (result.status !== "active") process.exitCode = 1;
    return result;
  }));
credentialCommand.command("remove").alias("rm").argument("<id>", "Credential ID")
  .description("Remove a stored credential").option("-y, --yes", "Skip confirmation")
  .action((id: string, opts) => printResult(async () => {
    await confirmOrExit(opts.yes, `Remove credential ${id}?`);
    return getShipClient().credentials.remove(id);
  }));
