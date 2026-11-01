import { Command } from "commander";
import { AuditQuerySchema, AuditSettingsInput, parseInput } from "@repo/contracts";
import { getShipClient } from "../lib/ship-client";
import { readJsonInput } from "../lib/command-input";
import { printResult } from "../lib/cmd-helpers";

export const auditCommand = new Command("audit").description("Inspect audit events and retention settings");
for (const [name, description] of [["list", "List audit events with pagination"], ["facets", "Show counts and available audit filters"]] as const) {
  auditCommand.command(name).description(description)
    .option("--query <file>", "JSON audit filters, dates, cursor or page settings")
    .action(opts => printResult(() => getShipClient().audit[name](parseInput(AuditQuerySchema, opts.query ? readJsonInput(opts.query) : {}))));
}
const settings = new Command("settings").description("Manage audit logging and retention");
settings.command("get").description("Show audit settings and management capability")
  .action(() => printResult(() => getShipClient().audit.getSettings()));
settings.command("set").argument("<file>", "JSON patch with enabled and/or retentionDays")
  .description("Update audit settings")
  .action((file: string) => printResult(() => getShipClient().audit.updateSettings(parseInput(AuditSettingsInput, readJsonInput(file)))));
auditCommand.addCommand(settings);
