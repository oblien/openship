import { Command } from "commander";
import { NotificationCollectionSchemas, NotificationResourceSchemas, parseInput } from "@repo/contracts";
import { getShipClient } from "../lib/ship-client";
import { readJsonInput } from "../lib/command-input";
import { confirmOrExit, printResult } from "../lib/cmd-helpers";

export const notificationCommand = new Command("notification").alias("notifications")
  .description("Manage notification channels, subscriptions and deliveries");
notificationCommand.command("categories").description("List notification categories and groups")
  .action(() => printResult(() => getShipClient().notifications.categories()));
const channel = new Command("channel").description("Configure notification delivery channels");
channel.command("list").description("List your channels")
  .action(() => printResult(() => getShipClient().notifications.listChannels()));
channel.command("create").argument("<file>", "JSON object containing kind, label and provider config")
  .description("Create a channel; any returned signing secret is shown once")
  .action((file: string) => printResult(() => getShipClient().notifications.createChannel(
    parseInput(NotificationCollectionSchemas.createChannel.input, readJsonInput(file)))));
channel.command("update").argument("<id>", "Channel ID").argument("<file>", "JSON patch containing label, enabled or config")
  .description("Update a channel")
  .action((id: string, file: string) => printResult(() => getShipClient().notifications.updateChannel(id,
    parseInput(NotificationResourceSchemas.updateChannel.input, readJsonInput(file)))));
channel.command("test").argument("<id>", "Channel ID").description("Send a test notification to this channel")
  .action((id: string) => printResult(async () => {
    const result = await getShipClient().notifications.testChannel(id);
    if (!result.ok) process.exitCode = 1;
    return result;
  }));
channel.command("remove").alias("rm").argument("<id>", "Channel ID")
  .description("Remove a notification channel").option("-y, --yes", "Skip confirmation")
  .action((id: string, opts) => printResult(async () => {
    await confirmOrExit(opts.yes, `Remove channel ${id}?`);
    return getShipClient().notifications.removeChannel(id);
  }));
notificationCommand.addCommand(channel);
const subscription = new Command("subscription").description("Choose which events use each channel");
subscription.command("list").description("List your notification subscriptions")
  .action(() => printResult(() => getShipClient().notifications.listSubscriptions()));
subscription.command("set").argument("<category>", "Notification category ID").requiredOption("--channel <id>", "Channel ID")
  .option("--disabled", "Disable this category/channel subscription")
  .description("Enable or disable delivery for one category and channel")
  .action((category: string, opts) => printResult(() => getShipClient().notifications.upsertSubscription({ category, channelId: opts.channel, enabled: !opts.disabled })));
subscription.command("remove").alias("rm").argument("<id>", "Subscription ID")
  .description("Remove a notification subscription")
  .action((id: string) => printResult(() => getShipClient().notifications.removeSubscription(id)));
notificationCommand.addCommand(subscription);
const defaults = new Command("defaults").description("Manage organization notification defaults");
defaults.command("get").description("Show organization defaults")
  .action(() => printResult(() => getShipClient().notifications.listDefaults()));
defaults.command("set").argument("<file>", "JSON default containing category, defaultEnabled and defaultChannelKinds")
  .description("Set organization defaults (requires admin access)")
  .action((file: string) => printResult(() => getShipClient().notifications.upsertDefault(
    parseInput(NotificationCollectionSchemas.upsertDefault.input, readJsonInput(file)))));
notificationCommand.addCommand(defaults);
const deliveries = new Command("deliveries").description("Inspect notification delivery attempts");
deliveries.command("list").option("--unseen", "Only unseen deliveries").option("--limit <n>", "Maximum deliveries", "50")
  .description("List deliveries and their status")
  .action(opts => printResult(() => getShipClient().notifications.listDeliveries({ unseen: opts.unseen, limit: Number(opts.limit) })));
deliveries.command("unseen-count").description("Count unseen deliveries")
  .action(() => printResult(() => getShipClient().notifications.unseenCount()));
deliveries.command("seen").argument("<id>", "Delivery ID").description("Mark a delivery as seen")
  .action((id: string) => printResult(() => getShipClient().notifications.markSeen(id)));
notificationCommand.addCommand(deliveries);
