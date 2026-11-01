import { Command, Option } from "commander";
import { managementBillingCommand } from "./billing-management";
import {
  BillingOperationSchemas,
  CreateSubscriptionBody,
  CreateTopupBody,
  PreviewSubscriptionChangeBody,
  ConfirmSubscriptionChangeBody,
  CustomServerResourcesSchema,
  parseInput,
} from "@repo/contracts";
import { getShipClient, type CliShipClient } from "../lib/ship-client";
import { positiveInteger, readJsonInput } from "../lib/command-input";
import { confirmOrExit, printResult } from "../lib/cmd-helpers";

interface ScopeOptions {
  server?: string;
  workspace?: string;
}
function scoped(command: Command): Command {
  return command
    .addOption(
      new Option("--server <id>", "Use this managed server's billing workspace").conflicts(
        "workspace",
      ),
    )
    .addOption(
      new Option(
        "--workspace <id>",
        "Billing workspace ID, including retained subscriptions",
      ).conflicts("server"),
    );
}
async function scope(ship: CliShipClient, options: ScopeOptions) {
  if (!options.server) return { workspaceId: options.workspace };
  const server = await ship.servers.get(options.server);
  if (!server.managed)
    throw new Error(
      "This server has no managed subscription. Choose a Cloud server or supply --workspace.",
    );
  return { workspaceId: server.managed.id };
}

export const billingCommand = new Command("billing").description(
  "Manage Cloud plans, server subscriptions, usage and payment checkouts",
);

billingCommand
  .command("plans")
  .description("Show the current plan catalog and prices")
  .option("--locale <locale>", "Catalog language")
  .action((opts) => printResult(() => getShipClient().billing.listPlans({ locale: opts.locale })));
billingCommand
  .command("quote")
  .description("Quote custom server capacity using current catalog pricing")
  .requiredOption("--cpu <cores>", "CPU cores", positiveInteger)
  .requiredOption("--memory <mb>", "Memory in MiB", positiveInteger)
  .requiredOption("--disk <gb>", "Storage in GiB", positiveInteger)
  .action((opts) =>
    printResult(() =>
      getShipClient().billing.quoteCustomPlan(
        parseInput(CustomServerResourcesSchema, {
          cpuCores: opts.cpu,
          memoryMb: opts.memory,
          diskGb: opts.disk,
        }),
      ),
    ),
  );

for (const [name, method, description] of [
  ["state", "getState", "Show the effective plan, allowance and billing state"],
  ["resources", "getResources", "Show measured compute and traffic usage"],
  ["allowances", "listAllowanceDetail", "Show allowance use and the resources consuming it"],
] as const) {
  scoped(billingCommand.command(name).description(description)).action((opts) =>
    printResult(async () => {
      const ship = getShipClient();
      return ship.billing[method](await scope(ship, opts));
    }),
  );
}
billingCommand
  .command("alerts")
  .description("Show credit and funding alerts")
  .action(() => printResult(() => getShipClient().billing.getCreditAlerts()));
scoped(billingCommand.command("usage").description("Read metered usage for a date range"))
  .option("--from <timestamp>", "Start timestamp")
  .option("--to <timestamp>", "End timestamp")
  .addOption(new Option("--group-by <period>", "Usage bucket size").choices(["hour", "day"]))
  .action((opts) =>
    printResult(async () => {
      const ship = getShipClient();
      return ship.billing.getUsage(
        parseInput(BillingOperationSchemas.getUsage.input, {
          ...(await scope(ship, opts)),
          from: opts.from,
          to: opts.to,
          groupBy: opts.groupBy,
        }),
      );
    }),
  );
scoped(
  billingCommand
    .command("portal")
    .description("Create a link to manage this subscription's payments"),
).action((opts) =>
  printResult(async () => {
    const ship = getShipClient();
    return ship.billing.createPortal(await scope(ship, opts));
  }),
);

const subscription = new Command("subscription").description(
  "Purchase, inspect or change a managed server subscription",
);
scoped(
  subscription.command("get").description("Read the current subscription and renewal state"),
).action((opts) =>
  printResult(async () => {
    const ship = getShipClient();
    return ship.billing.getSubscription(await scope(ship, opts));
  }),
);
scoped(subscription.command("create").argument("<plan>", "Plan ID from billing plans"))
  .description("Create a checkout; complete payment at the returned URL")
  .addOption(
    new Option("--interval <period>", "Billing interval")
      .choices(["monthly", "annual"])
      .default("monthly"),
  )
  .option("--custom <file>", "JSON resources and quoteReference from billing quote")
  .option("--idempotency-key <key>", "Reuse this key when recovering the same checkout request")
  .action((plan: string, opts) =>
    printResult(async () => {
      // Validate the selection before resolving a server or creating a checkout.
      const selection = parseInput(CreateSubscriptionBody, {
        planTierId: plan,
        interval: opts.interval,
        custom: opts.custom ? readJsonInput(opts.custom) : undefined,
        idempotencyKey: opts.idempotencyKey,
      });
      const ship = getShipClient();
      return ship.billing.createSubscription({ ...selection, ...(await scope(ship, opts)) });
    }),
  );
for (const [name, method, question] of [
  ["cancel", "cancelSubscription", "Cancel renewal of this subscription?"],
  ["resume", "resumeSubscription", "Resume renewal of this subscription?"],
] as const) {
  scoped(subscription.command(name).description(question.slice(0, -1)))
    .option("-y, --yes", "Confirm the renewal change")
    .action((opts) =>
      printResult(async () => {
        await confirmOrExit(opts.yes, question);
        const ship = getShipClient();
        return ship.billing[method](await scope(ship, opts));
      }),
    );
}
billingCommand.addCommand(subscription);

const change = new Command("change").description(
  "Preview and confirm a subscription change with its exact quote",
);
scoped(change.command("preview").argument("<plan>", "Next plan ID"))
  .description("Create a quote showing the price and affected-project restarts")
  .requiredOption("--idempotency-key <key>", "Stable key for this change request")
  .option("--custom <file>", "JSON custom resources and quoteReference")
  .action((plan: string, opts) =>
    printResult(async () => {
      const selection = parseInput(PreviewSubscriptionChangeBody, {
        planTierId: plan,
        idempotencyKey: opts.idempotencyKey,
        custom: opts.custom ? readJsonInput(opts.custom) : undefined,
      });
      const ship = getShipClient();
      return ship.billing.previewSubscriptionChange({ ...selection, ...(await scope(ship, opts)) });
    }),
  );
scoped(change.command("apply").argument("<quote>", "Exact quote ID returned by change preview"))
  .description("Confirm a reviewed quote and its listed server restarts")
  .requiredOption("--confirm-restart", "Acknowledge the restarts listed in this quote")
  .option("-y, --yes", "Confirm this subscription change")
  .action((quoteId: string, opts) =>
    printResult(async () => {
      const input = parseInput(ConfirmSubscriptionChangeBody, {
        quoteId,
        confirmRestart: opts.confirmRestart,
      });
      await confirmOrExit(opts.yes, `Apply quote ${quoteId} and its listed restarts?`);
      const ship = getShipClient();
      return ship.billing.confirmSubscriptionChange({ ...input, ...(await scope(ship, opts)) });
    }),
  );
scoped(
  change
    .command("get")
    .argument("<id>", "Change ID")
    .description("Read a queued, applied or failed change"),
).action((changeId: string, opts) =>
  printResult(async () => {
    const ship = getShipClient();
    return ship.billing.getSubscriptionChange({ ...(await scope(ship, opts)), changeId });
  }),
);
scoped(
  change
    .command("cancel")
    .argument("<id>", "Change ID")
    .description("Cancel a change if its current state permits it"),
)
  .option("-y, --yes", "Confirm cancellation")
  .action((changeId: string, opts) =>
    printResult(async () => {
      await confirmOrExit(opts.yes, `Cancel change ${changeId}?`);
      const ship = getShipClient();
      return ship.billing.cancelSubscriptionChange({ ...(await scope(ship, opts)), changeId });
    }),
  );
billingCommand.addCommand(change);

const checkout = new Command("checkout").description(
  "Recover existing payment checkouts without creating another purchase",
);
scoped(checkout.command("list").description("List open and recoverable checkouts")).action((opts) =>
  printResult(async () => {
    const ship = getShipClient();
    return ship.billing.listCheckouts(await scope(ship, opts));
  }),
);
scoped(
  checkout
    .command("get")
    .argument("<id>", "Checkout ID")
    .description("Read payment and provisioning status"),
).action((checkoutId: string, opts) =>
  printResult(async () => {
    const ship = getShipClient();
    return ship.billing.getCheckout({ ...(await scope(ship, opts)), checkoutId });
  }),
);
for (const [name, method] of [
  ["resume", "resumeCheckout"],
  ["cancel", "cancelCheckout"],
] as const) {
  const command = scoped(
    checkout
      .command(name)
      .argument("<id>", "Action ID from checkout list")
      .description(
        name === "resume" ? "Resume this existing checkout" : "Cancel this unpaid checkout",
      ),
  );
  if (name === "cancel") command.option("-y, --yes", "Confirm cancellation");
  command.action((id: string, opts) =>
    printResult(async () => {
      if (!opts.server && !opts.workspace)
        throw new Error("Supply --server or --workspace for this checkout action.");
      if (name === "cancel") await confirmOrExit(opts.yes, `Cancel checkout ${id}?`);
      const ship = getShipClient();
      return ship.billing[method](
        parseInput(BillingOperationSchemas[method].input, { ...(await scope(ship, opts)), id }),
      );
    }),
  );
}
billingCommand.addCommand(checkout);

const topup = new Command("topup").description("Add usage credit through a payment checkout");
topup
  .command("packs")
  .description("List current funding packages")
  .action(() => printResult(() => getShipClient().billing.listTopupPacks()));
scoped(topup.command("create").argument("<pack>", "Pack ID from topup packs"))
  .description("Create a top-up checkout; complete payment at the returned URL")
  .option("--idempotency-key <key>", "Stable key for this top-up request")
  .action((packId: string, opts) =>
    printResult(async () => {
      const selection = parseInput(CreateTopupBody, {
        packId,
        idempotencyKey: opts.idempotencyKey,
      });
      const ship = getShipClient();
      return ship.billing.createTopup({ ...selection, ...(await scope(ship, opts)) });
    }),
  );
billingCommand.addCommand(topup);

billingCommand.addCommand(managementBillingCommand);
