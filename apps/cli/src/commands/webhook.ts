import { Command } from "commander";
import { CreateIncomingWebhookBody, UpdateIncomingWebhookBody, parseInput } from "@repo/contracts";
import { getShipClient } from "../lib/ship-client";
import { readJsonInput } from "../lib/command-input";
import { confirmOrExit, printResult } from "../lib/cmd-helpers";

export const webhookCommand = new Command("webhook").description("Manage incoming deploy and job webhooks");
const scoped = (name: string) => new Command(name).requiredOption("-p, --project <id>", "Project ID");
webhookCommand.addCommand(scoped("list").description("List a project's incoming webhooks")
  .action(opts => printResult(() => getShipClient().webhooks.list(opts.project))));
webhookCommand.addCommand(scoped("create").argument("<file>", "JSON webhook definition")
  .description("Create a webhook; credentials in the result must be kept private")
  .action((file: string, opts) => printResult(() => getShipClient().webhooks.create(opts.project,
    parseInput(CreateIncomingWebhookBody, readJsonInput(file))))));
webhookCommand.addCommand(scoped("update").argument("<id>", "Webhook ID").argument("<file>", "JSON webhook patch")
  .description("Update a webhook using the shared authorization rules")
  .action((id: string, file: string, opts) => printResult(() => getShipClient().webhooks.update(opts.project, id,
    parseInput(UpdateIncomingWebhookBody, readJsonInput(file))))));
webhookCommand.addCommand(scoped("invoke").argument("<id>", "Webhook ID")
  .description("Run this webhook's configured action as the current caller")
  .action((id: string, opts) => printResult(() => getShipClient().webhooks.invoke(opts.project, id))));
for (const [name, method, description] of [
  ["rotate", "rotate", "Rotate a webhook's credential"],
  ["remove", "remove", "Remove a webhook"],
] as const) {
  webhookCommand.addCommand(scoped(name).argument("<id>", "Webhook ID").description(description)
    .option("-y, --yes", "Skip confirmation")
    .action((id: string, opts) => printResult(async () => {
      await confirmOrExit(opts.yes, `${description}: ${id}?`);
      return getShipClient().webhooks[method](opts.project, id);
    })));
}
webhookCommand.addCommand(scoped("deliveries").option("--hook <id>", "Only one webhook's deliveries")
  .option("--cursor <cursor>", "Continue from the returned nextCursor").option("--limit <n>", "Page size", "50")
  .description("Inspect webhook deliveries with cursor pagination")
  .action(opts => printResult(() => {
    const client = getShipClient();
    const input = { cursor: opts.cursor, limit: Number(opts.limit) };
    return opts.hook ? client.webhooks.hookDeliveries(opts.project, opts.hook, input) : client.webhooks.deliveries(opts.project, input);
  })));
