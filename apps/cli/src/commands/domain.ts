import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { exitCommand, rethrowCommandExit } from "../lib/command-exit";
/**
 * `openship domain` — custom domains, DNS verification, and SSL.
 *
 * Uses the named SDK operations shared with native integrations.
 */

import { Command, Option } from "commander";
import { UploadCertBody, UpdateDomainBody, parseInput } from "@repo/contracts";
import { readFileSync } from "node:fs";
import { attachCustomDomainEndpoint } from "../lib/custom-domain-endpoint";
import { getShipClient } from "../lib/ship-client";
import { spin, fail, confirmOrExit, printResult } from "../lib/cmd-helpers";
import type { Domain, DomainRecords, DomainSsl } from "@repo/sdk/client";
import { printJson, printTable, isJsonMode, ok, err, info } from "../lib/output";
import { positiveInteger, timeoutMilliseconds } from "../lib/command-input";
import { printEvents } from "../lib/event-output";

// ─── Shapes (subset of @repo/db Domain we render) ────────────────────────────

// ─── Helpers ─────────────────────────────────────────────────────────────────

function domainRow(d: Domain): Record<string, unknown> {
  return {
    id: d.id,
    hostname: d.hostname,
    type: d.domainType ?? "",
    primary: d.isPrimary ? "yes" : "",
    verified: d.verified ? "yes" : "no",
    status: d.status ?? "",
    ssl: d.sslStatus ?? "",
  };
}

/** Render a DNS-records result: the mode line plus a type/host/value table. */
function printRecords(result: DomainRecords): void {
  if (isJsonMode()) {
    printJson(result);
    return;
  }
  info(`  DNS mode: ${result.mode}`);
  printTable(
    result.records.map((r) => ({ type: r.type, host: r.host, value: r.value })),
    ["type", "host", "value"],
  );
}

// ─── Subcommands ─────────────────────────────────────────────────────────────

const listCmd = new Command("list")
  .description("List a project's custom domains")
  .requiredOption("-p, --project <id>", "Project ID to list domains for")
  .action(async (opts) => {
    try {
      const rows = await getShipClient().domains.list(opts.project);
      if (isJsonMode()) {
        printJson(rows);
        return;
      }
      printTable(rows.map(domainRow), ["id", "hostname", "type", "primary", "verified", "status", "ssl"]);
    } catch (e) {
      observeCaughtError(e, "cli/commands/domain");
      rethrowCommandExit(e);
      fail(e);
    }
  });

const addCmd = new Command("add")
  .description("Add a custom domain and route it on the next deploy")
  .argument("<hostname>", "Domain hostname (e.g. app.example.com)")
  .requiredOption("-p, --project <id>", "Project ID to attach the domain to")
  .option("--primary", "Mark this domain as the project's primary", false)
  .action(async (hostname: string, opts) => {
    const sp = spin(`Adding ${hostname}…`);
    try {
      const ship = getShipClient();
      const res = await ship.domains.create(opts.project, { hostname, isPrimary: !!opts.primary });
      const routed = await attachCustomDomainEndpoint(ship, opts.project, res.domain.hostname);
      sp?.succeed(`Added ${res.domain.hostname}`);
      if (routed) info(`  ${res.domain.hostname} is configured to be routed on the next deploy.`);
      if (isJsonMode()) {
        printJson(res);
        return;
      }
      info("  Add these DNS records at your registrar, then run `openship domain verify " + res.domain.id + "`:");
      if (res.records) printRecords(res.records);
    } catch (e) {
      observeCaughtError(e, "cli/commands/domain");
      rethrowCommandExit(e);
      sp?.fail("Add failed");
      fail(e);
    }
  });

const previewCmd = new Command("preview")
  .description("Preview the DNS records a hostname would need (no changes saved)")
  .argument("<hostname>", "Domain hostname to preview")
  .action(async (hostname: string) => {
    try {
      printRecords(await getShipClient().domains.preview({ hostname }));
    } catch (e) {
      observeCaughtError(e, "cli/commands/domain");
      rethrowCommandExit(e);
      fail(e);
    }
  });

const verifyCmd = new Command("verify")
  .description("Run DNS verification for a domain")
  .argument("<id>", "Domain ID")
  .option("--force", "Recheck an already-verified hostname")
  .option("--follow", "Stream DNS and certificate progress")
  .option("--timeout <ms>", "Stop following after this deadline", timeoutMilliseconds)
  .action(async (id: string, opts) => {
    const sp = spin("Checking DNS records…");
    try {
      if (opts.follow) {
        sp?.stop();
        await printEvents(getShipClient().domains.verifyStream(id, { force: opts.force }, { signal: opts.timeout ? AbortSignal.timeout(opts.timeout) : undefined }));
        return;
      }
      const body = await getShipClient().domains.verify(id, { force: opts.force });
      if (isJsonMode()) {
        sp?.stop();
        printJson(body);
        if (!body.verified) exitCommand(1);
        return;
      }
      if (body.verified) {
        sp?.succeed(body.message || "Domain verified");
      } else {
        sp?.fail(body.message || "Not verified yet");
      }
      info(`  route/CNAME: ${body.cnameVerified ? "ok" : "missing"}   TXT: ${body.txtVerified ? "ok" : "missing"}`);
      if (body.sslStatus) info(`  SSL: ${body.sslStatus}`);
      if (!body.verified) exitCommand(1);
    } catch (e) {
      observeCaughtError(e, "cli/commands/domain");
      rethrowCommandExit(e);
      sp?.fail("Verify failed");
      fail(e);
    }
  });

const primaryCmd = new Command("primary")
  .description("Make a domain the project's primary hostname")
  .argument("<id>", "Domain ID")
  .action(async (id: string) => {
    const sp = spin("Setting primary…");
    try {
      const domain = await getShipClient().domains.setPrimary(id);
      sp?.succeed(`${domain.hostname} is now primary`);
      if (isJsonMode()) printJson(domain);
    } catch (e) {
      observeCaughtError(e, "cli/commands/domain");
      rethrowCommandExit(e);
      sp?.fail("Failed to set primary");
      fail(e);
    }
  });

const recordsCmd = new Command("records")
  .description("Show the DNS records for an existing domain")
  .argument("<id>", "Domain ID")
  .action(async (id: string) => {
    try {
      printRecords(await getShipClient().domains.records(id));
    } catch (e) {
      observeCaughtError(e, "cli/commands/domain");
      rethrowCommandExit(e);
      fail(e);
    }
  });

function printSsl(data: DomainSsl): void {
  if (isJsonMode()) {
    printJson(data);
    return;
  }
  info(`  domain:  ${data.domain}`);
  info(`  status:  ${data.sslStatus}`);
  if (data.issuer) info(`  issuer:  ${data.issuer}`);
  if (data.expiresAt) info(`  expires: ${data.expiresAt}`);
}

const renewCmd = new Command("renew")
  .description("Renew the SSL certificate for a domain")
  .argument("<id>", "Domain ID")
  .action(async (id: string) => {
    const sp = spin("Renewing certificate…");
    try {
      const data = await getShipClient().domains.renewSsl(id);
      sp?.succeed(`Renewed ${data.domain}`);
      printSsl(data);
    } catch (e) {
      observeCaughtError(e, "cli/commands/domain");
      rethrowCommandExit(e);
      sp?.fail("Renew failed");
      fail(e);
    }
  });

const verifySslCmd = new Command("verify-ssl")
  .description("Recheck that a domain's SSL certificate is issued and valid (no reissue)")
  .argument("<id>", "Domain ID")
  .action(async (id: string) => {
    const sp = spin("Checking certificate…");
    try {
      const data = await getShipClient().domains.verifySsl(id);
      if (data.verified) sp?.succeed(`Certificate valid for ${data.domain}`);
      else sp?.fail(`Certificate not valid yet for ${data.domain}`);
      printSsl(data);
      if (!data.verified) exitCommand(1);
    } catch (e) {
      observeCaughtError(e, "cli/commands/domain");
      rethrowCommandExit(e);
      sp?.fail("SSL check failed");
      fail(e);
    }
  });

const renewAllCmd = new Command("renew-all")
  .description("Renew SSL for every near-expiry domain in your organization")
  .action(async () => {
    const sp = spin("Renewing expiring certificates…");
    try {
      const data = await getShipClient().domains.renewAllSsl();
      sp?.succeed(`Renewed ${data.renewed} domain(s)`);
      if (isJsonMode()) {
        printJson(data);
        return;
      }
      if (data.results.length > 0) {
        printTable(
          data.results.map((r) => ({ domain: r.domain, status: r.status, error: r.error ?? "" })),
          ["domain", "status", "error"],
        );
      } else {
        info("  Nothing needed renewal.");
      }
    } catch (e) {
      observeCaughtError(e, "cli/commands/domain");
      rethrowCommandExit(e);
      sp?.fail("Renew-all failed");
      fail(e);
    }
  });

const dnsCmd = new Command("dns").description("Plan and apply provider-managed DNS records");
dnsCmd.command("plan").argument("<id>", "Domain ID").option("--server <id>", "Target server ID")
  .description("Preview DNS record changes without applying them")
  .action((id: string, opts) => printResult(() => getShipClient().domains.dnsPlan(id, { serverId: opts.server })));
dnsCmd.command("apply").argument("<id>", "Domain ID").option("--server <id>", "Target server ID")
  .description("Apply DNS records through the shared provider workflow")
  .action((id: string, opts) => printResult(async () => {
    const result = await getShipClient().domains.dnsApply(id, { serverId: opts.server });
    if (!result.provisioned) process.exitCode = 1;
    return result;
  }));
const challengeCmd = new Command("challenge").description("Manage a DNS certificate challenge");
challengeCmd.command("get").argument("<id>", "Domain ID").description("Inspect the current challenge and required TXT record")
  .action((id: string) => printResult(() => getShipClient().domains.dnsChallenge(id)));
challengeCmd.command("start").argument("<id>", "Domain ID")
  .addOption(new Option("--mode <mode>", "Use a DNS provider or add the TXT record yourself").choices(["automatic", "manual"]).default("automatic"))
  .option("--force", "Request a new certificate even if the current certificate is still valid")
  .description("Start a certificate challenge through the shared certificate workflow")
  .action((id: string, opts) => printResult(() => getShipClient().domains.startDnsChallenge(id, { mode: opts.mode, force: opts.force })));
for (const [name, method] of [["check", "checkDnsChallenge"], ["cancel", "cancelDnsChallenge"]] as const) {
  challengeCmd.command(name).argument("<id>", "Domain ID").requiredOption("--attempt <id>", "Exact challenge attempt ID from start/get")
    .description(`${name === "check" ? "Check the TXT record for" : "Cancel"} a specific challenge attempt`)
    .action((id: string, opts) => printResult(async () => {
      const result = await getShipClient().domains[method](id, { attemptId: opts.attempt });
      if (result.status === "failed" || result.status === "expired") process.exitCode = 1;
      return result;
    }));
}
dnsCmd.addCommand(challengeCmd);

// ─── Parent group ────────────────────────────────────────────────────────────

export const domainCommand = new Command("domain")
  .description("Manage custom domains, DNS verification, and SSL certificates")
  .addCommand(listCmd)
  .addCommand(addCmd)
  .addCommand(previewCmd)
  .addCommand(verifyCmd)
  .addCommand(primaryCmd)
  .addCommand(recordsCmd)
  .addCommand(renewCmd)
  .addCommand(verifySslCmd)
  .addCommand(renewAllCmd)
  .addCommand(dnsCmd);
domainCommand.command("get").argument("<id>", "Domain ID").description("Show a domain and its routing configuration")
  .action((id: string) => printResult(() => getShipClient().domains.get(id)));
domainCommand.command("remove").alias("rm").argument("<id>", "Domain ID")
  .description("Remove a domain and its managed route").option("-y, --yes", "Skip confirmation")
  .action((id: string, opts) => printResult(async () => {
    await confirmOrExit(opts.yes, `Remove domain ${id}?`);
    return getShipClient().domains.remove(id);
  }));
domainCommand.command("upload-cert").argument("<id>", "Domain ID")
  .requiredOption("--cert <file>", "PEM certificate chain file")
  .requiredOption("--key <file>", "PEM private key file")
  .description("Install a manual certificate through the shared hostname and key validation")
  .action((id: string, opts) => printResult(() => getShipClient().domains.uploadCert(id, parseInput(UploadCertBody, {
    certPem: readFileSync(opts.cert, "utf8"), keyPem: readFileSync(opts.key, "utf8"),
  }))));
domainCommand.command("verify-pending").description("Retry eligible pending domains within the selected organization")
  .option("--limit <number>", "Maximum domains to inspect", positiveInteger)
  .option("--min-age <minutes>", "Minimum pending age in minutes", positiveInteger)
  .action(opts => printResult(async () => {
    const result = await getShipClient().domains.verifyPending({ limit: opts.limit, minAgeMinutes: opts.minAge });
    if (result.failed) process.exitCode = 1;
    return result;
  }));

domainCommand
  .command("update")
  .argument("<id>", "Domain ID")
  .description(
    "Set the HTTP body cap on a self-hosted nginx/OpenResty domain; compare the saved cap with the observed server-block configuration in project Edge config",
  )
  .addOption(
    new Option(
      "--client-max-body-size <size>",
      "Custom HTTP body cap (e.g. 2m, 1g; 0 = unlimited)",
    ).conflicts("inheritClientMaxBodySize"),
  )
  .addOption(
    new Option(
      "--inherit-client-max-body-size",
      "Clear the domain override and inherit the project body cap",
    ).conflicts("clientMaxBodySize"),
  )
  .action((id: string, opts) =>
    printResult(() => {
      if (opts.clientMaxBodySize === undefined && !opts.inheritClientMaxBodySize) {
        throw new Error("Choose --client-max-body-size or --inherit-client-max-body-size");
      }
      return getShipClient().domains.update(
        id,
        parseInput(UpdateDomainBody, {
          proxy: opts.inheritClientMaxBodySize
            ? null
            : { clientMaxBodySize: opts.clientMaxBodySize },
        }),
      );
    }),
  );
