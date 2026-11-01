import { Command } from "commander";
import { ManagementBillingOperationSchemas, parseInput } from "@repo/contracts";
import { getShipClient } from "../lib/ship-client";
import { positiveInteger } from "../lib/command-input";
import { confirmOrExit, printResult } from "../lib/cmd-helpers";

export const managementBillingCommand = new Command("manage").description(
  "Hosted management for your own servers; scoped to the active organization",
);
managementBillingCommand
  .command("get")
  .description("Show the paid allowance, subscription, pending checkout and changes")
  .action(() => printResult(() => getShipClient().billing.getManagement()));
managementBillingCommand
  .command("purchase")
  .description("Create a payment link or preview an allowance change without confirming it")
  .requiredOption("--servers <count>", "Total connected-server allowance", positiveInteger)
  .requiredOption("--idempotency-key <key>", "Reuse this key to recover the same purchase")
  .action((opts) =>
    printResult(() =>
      getShipClient().billing.purchaseManagement(
        parseInput(ManagementBillingOperationSchemas.purchaseManagement.input, {
          servers: opts.servers,
          idempotencyKey: opts.idempotencyKey,
        }),
      ),
    ),
  );
managementBillingCommand
  .command("apply")
  .argument("<quote>", "Exact quote ID from manage purchase")
  .description("Confirm a reviewed allowance quote and its amount due")
  .option("-y, --yes", "Confirm this subscription change")
  .action((quoteId: string, opts) =>
    printResult(async () => {
      const input = parseInput(ManagementBillingOperationSchemas.confirmManagementChange.input, {
        quoteId,
      });
      await confirmOrExit(opts.yes, `Apply Manage quote ${quoteId} and its amount due?`);
      return getShipClient().billing.confirmManagementChange(input);
    }),
  );
for (const [name, method, question] of [
  ["cancel-change", "cancelManagementChange", "Cancel the pending Manage allowance change?"],
  [
    "cancel",
    "cancelManagementSubscription",
    "Cancel Manage renewal? Apps and data stay on your servers.",
  ],
  ["resume", "resumeManagementSubscription", "Resume Manage renewal at its saved price?"],
] as const) {
  managementBillingCommand
    .command(name)
    .description(question.replace(/\?$/, ""))
    .option("-y, --yes", "Confirm this subscription change")
    .action((opts) =>
      printResult(async () => {
        await confirmOrExit(opts.yes, question);
        return getShipClient().billing[method]();
      }),
    );
}
managementBillingCommand
  .command("portal")
  .description("Open payment details and invoices for Manage")
  .action(() => printResult(() => getShipClient().billing.createManagementPortal()));
const checkout = new Command("checkout").description("Recover or cancel the saved Manage checkout");
checkout
  .command("resume")
  .description("Resume the existing checkout without another purchase")
  .action(() => printResult(() => getShipClient().billing.resumeManagementCheckout()));
checkout
  .command("cancel")
  .description("Cancel the saved unpaid Manage checkout")
  .option("-y, --yes", "Confirm checkout cancellation")
  .action((opts) =>
    printResult(async () => {
      await confirmOrExit(opts.yes, "Cancel the saved Manage checkout?");
      return getShipClient().billing.cancelManagementCheckout();
    }),
  );
managementBillingCommand.addCommand(checkout);
