import { Command } from "commander";
import { getShipClient } from "../lib/ship-client";
import { timeoutMilliseconds } from "../lib/command-input";
import { printResult } from "../lib/cmd-helpers";
import { printEvents } from "../lib/event-output";

export const analyticsCommand = new Command("analytics").description(
  "Read project traffic, deployments and runtime resource measurements",
);
analyticsCommand
  .command("dashboard")
  .description("Show totals for accessible projects and deployments")
  .action(() => printResult(() => getShipClient().analytics.dashboard()));
analyticsCommand
  .command("summary")
  .argument("<project>", "Project ID")
  .option("--domain <domain>", "Route filter")
  .description("Show request, visitor and bandwidth totals")
  .action((id: string, opts) =>
    printResult(() => getShipClient().analytics.summary(id, { domain: opts.domain })),
  );
for (const [name, method, description] of [
  ["traffic", "overview", "Show traffic totals and time buckets"],
  ["periods", "periods", "Read traffic time buckets"],
  ["geo", "geo", "Read traffic geography and request paths"],
] as const) {
  analyticsCommand
    .command(name)
    .argument("<project>", "Project ID")
    .description(description)
    .option("--from <timestamp>", "ISO start time")
    .option("--to <timestamp>", "ISO end time")
    .option("--domain <domain>", "Route filter")
    .action((id: string, opts) =>
      printResult(() =>
        getShipClient().analytics[method](id, {
          from: opts.from,
          to: opts.to,
          domain: opts.domain,
        }),
      ),
    );
}
for (const [name, method, description] of [
  ["deployments", "deploymentStats", "Show deployment reliability and build duration"],
  ["usage", "usage", "Read current project runtime usage"],
  ["container", "containerInfo", "Read runtime container details"],
  ["resources", "resources", "Read service measurements and destination capacity"],
] as const) {
  analyticsCommand
    .command(name)
    .argument("<project>", "Project ID")
    .description(description)
    .action((id: string) => printResult(() => getShipClient().analytics[method](id)));
}
analyticsCommand
  .command("history")
  .argument("<project>", "Project ID")
  .option("--from <timestamp>", "ISO start time")
  .option("--to <timestamp>", "ISO end time")
  .option("--service <key>", "Service key from history results")
  .description("Read historical CPU, memory and network usage")
  .action((id: string, opts) =>
    printResult(() =>
      getShipClient().analytics.usageHistory(id, {
        from: opts.from,
        to: opts.to,
        serviceKey: opts.service,
      }),
    ),
  );
analyticsCommand
  .command("paths")
  .argument("<project>", "Project ID")
  .argument("<state>", "on | off")
  .description("Enable or disable collection of request paths")
  .action((id: string, state: string) =>
    printResult(() => {
      if (state !== "on" && state !== "off") throw new Error("Use on or off.");
      return getShipClient().analytics.setPathsCollection(id, { enabled: state === "on" });
    }),
  );
analyticsCommand
  .command("watch")
  .argument("<project>", "Project ID")
  .description("Stream live project resource measurements")
  .option("--timeout <ms>", "Stop after this deadline", timeoutMilliseconds)
  .action((id: string, opts) =>
    printEvents(
      getShipClient().analytics.streamUsage(id, {
        signal: opts.timeout ? AbortSignal.timeout(opts.timeout) : undefined,
      }),
    ),
  );
// Server-level traffic is the same analytics operation used by edge commands.
const server = new Command("server").description(
  "Inspect traffic for a domain handled by a particular server",
);
server
  .command("buckets")
  .argument("<server>", "Server ID")
  .argument("<domain>", "Hostname")
  .option("--from <timestamp>", "ISO start time")
  .option("--to <timestamp>", "ISO end time")
  .description("Read stored domain traffic buckets")
  .action((id: string, domain: string, opts) =>
    printResult(() =>
      getShipClient().analytics.serverBuckets(id, { domain, from: opts.from, to: opts.to }),
    ),
  );
server
  .command("geo")
  .argument("<server>", "Server ID")
  .argument("<domain>", "Hostname")
  .option("--day <date>", "UTC day as YYYYMMDD")
  .description("Read domain traffic geography")
  .action((id: string, domain: string, opts) =>
    printResult(() => getShipClient().analytics.serverGeo(id, { domain, day: opts.day })),
  );
server
  .command("live")
  .argument("<server>", "Server ID")
  .argument("<domain>", "Hostname")
  .description("Read current domain traffic counters")
  .action((id: string, domain: string) =>
    printResult(() => getShipClient().analytics.serverLive(id, { domain })),
  );
analyticsCommand.addCommand(server);
