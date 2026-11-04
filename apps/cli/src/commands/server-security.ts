import { Command } from "commander";
import { ServerSecuritySchemas } from "@repo/contracts";
import { getShipClient } from "../lib/ship-client";
import { printResult } from "../lib/cmd-helpers";
import { jsonResourceCommand } from "../lib/json-command";

export const serverSecurityCommand = new Command("security").description(
  "Inspect server advisories and review host maintenance runs",
);
serverSecurityCommand
  .command("get")
  .argument("<id>", "Server ID")
  .description("Read cached findings and inspection freshness")
  .action((id: string) => printResult(() => getShipClient().servers.security(id)));
serverSecurityCommand
  .command("check")
  .argument("<id>", "Server ID")
  .description("Inspect the host without installing packages")
  .action((id: string) => printResult(() => getShipClient().servers.checkSecurity(id)));
serverSecurityCommand
  .command("runs")
  .argument("<id>", "Server ID")
  .description("Read this server's patch and reboot history")
  .action((id: string) => printResult(() => getShipClient().servers.securityRuns(id)));
jsonResourceCommand(
  serverSecurityCommand
    .command("plan")
    .description(
      "Review exact package changes or a kernel reboot; package planning refreshes APT indexes",
    ),
  ServerSecuritySchemas.planSecurityPatch.input,
  (id, input) => getShipClient().servers.planSecurityPatch(id, input),
);
jsonResourceCommand(
  serverSecurityCommand
    .command("apply")
    .description("Apply the reviewed expiring token and return a server run ID"),
  ServerSecuritySchemas.applySecurityPatch.input,
  (id, input) => getShipClient().servers.applySecurityPatch(id, input),
  "Apply this reviewed server maintenance plan? Services may restart; a reboot plan interrupts every workload.",
);
