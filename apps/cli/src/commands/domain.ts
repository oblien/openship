import { exitCommand, rethrowCommandExit } from "../lib/command-exit";
/**
 * `openship domain` — custom domains, DNS verification, and SSL.
 *
 * Uses the named SDK operations shared with native integrations.
 */

import { Command } from "commander";
import chalk from "chalk";
import ora, { type Ora } from "ora";
import { getShipClient, ApiError } from "../lib/ship-client";
import type { Domain, DomainRecords, DomainSsl } from "@repo/sdk/client";
import { printJson, printTable, isJsonMode, ok, err, info } from "../lib/output";

// ─── Shapes (subset of @repo/db Domain we render) ────────────────────────────

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Suppress the spinner in JSON mode so stdout stays a clean data stream. */
function spin(text: string): Ora | null {
  return isJsonMode() ? null : ora(text).start();
}

/** Print an ApiError (or any error) and exit non-zero. */
function fail(e: unknown): never {
  if (e instanceof ApiError) {
    err(`  ${e.message}${e.status ? chalk.dim(` (${e.status})`) : ""}`);
  } else {
    err(`  ${e instanceof Error ? e.message : String(e)}`);
  }
  exitCommand(1);
}

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
      rethrowCommandExit(e);
      fail(e);
    }
  });

const addCmd = new Command("add")
  .description("Add a custom domain to a project")
  .argument("<hostname>", "Domain hostname (e.g. app.example.com)")
  .requiredOption("-p, --project <id>", "Project ID to attach the domain to")
  .option("--primary", "Mark this domain as the project's primary", false)
  .action(async (hostname: string, opts) => {
    const sp = spin(`Adding ${hostname}…`);
    try {
      const res = await getShipClient().domains.create(opts.project, { hostname, isPrimary: !!opts.primary });
      sp?.succeed(`Added ${res.domain.hostname}`);
      if (isJsonMode()) {
        printJson(res);
        return;
      }
      info("  Add these DNS records at your registrar, then run `openship domain verify " + res.domain.id + "`:");
      if (res.records) printRecords(res.records);
    } catch (e) {
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
      rethrowCommandExit(e);
      fail(e);
    }
  });

const verifyCmd = new Command("verify")
  .description("Run DNS verification for a domain")
  .argument("<id>", "Domain ID")
  .action(async (id: string) => {
    const sp = spin("Checking DNS records…");
    try {
      const body = await getShipClient().domains.verify(id);
      if (isJsonMode()) {
        sp?.stop();
        printJson(body);
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
      if (!isJsonMode() && !data.verified) exitCommand(1);
    } catch (e) {
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
      rethrowCommandExit(e);
      sp?.fail("Renew-all failed");
      fail(e);
    }
  });

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
  .addCommand(renewAllCmd);
