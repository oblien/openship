import { Command, Option } from "commander";
import { getShipClient } from "../lib/ship-client";
import { confirmOrExit, printResult } from "../lib/cmd-helpers";

export const monitoringCommand = new Command("monitoring")
  .description("Inspect issues and workload health using the platform's monitoring operations");
monitoringCommand.command("issues")
  .description("List issues with counts and available recovery actions")
  .addOption(new Option("--status <status>", "Issue status").choices(["open", "resolved"]).default("open"))
  .action(opts => printResult(() => getShipClient().issues.list({ status: opts.status })));
monitoringCommand.command("summary").description("Show open issue counts")
  .action(() => printResult(() => getShipClient().issues.summary()));
monitoringCommand.command("clear-history")
  .description("Clear resolved incidents in the selected organization; preserves active issues (self-hosted owner/admin)")
  .option("-y, --yes", "Confirm permanent removal of resolved incident history")
  .action(opts => printResult(async () => {
    await confirmOrExit(opts.yes, "Permanently clear resolved monitoring history in this organization?");
    return getShipClient().issues.clearHistory();
  }));
monitoringCommand.command("health").description("Show workload health, scan freshness and watcher capabilities")
  .action(() => printResult(() => getShipClient().issues.health()));
monitoringCommand.command("scan").description("Run an authorized current workload health scan")
  .action(() => printResult(() => getShipClient().issues.scanHealth()));
const rescan = new Command("rescan").description("Run the shared instance rescan (self-hosted administrator)")
  .option("--health-only", "Check health without running infrastructure or update jobs")
  .action(opts => printResult(() => getShipClient().issues.rescan({ healthOnly: opts.healthOnly })));
rescan.command("status").description("Inspect the current instance rescan")
  .action(() => printResult(() => getShipClient().issues.rescanStatus()));
monitoringCommand.addCommand(rescan);
const watch = new Command("watch").description("Configure the existing engine health watcher");
for (const [name, enabled] of [["enable", true], ["disable", false]] as const) {
  watch.command(name).description(`${enabled ? "Enable" : "Disable"} continuous container monitoring when permitted by this instance`)
    .action(() => printResult(async () => {
      const client = getShipClient();
      const { watcher } = await client.issues.health();
      if (!watcher.available || !watcher.canManage)
        throw new Error("This connection cannot manage continuous monitoring. Check openship monitoring health for its capabilities.");
      return client.jobs.update(watcher.key, { enabled });
    }));
}
monitoringCommand.addCommand(watch);
