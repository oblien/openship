/**
 * `openship domain` — custom domains, DNS verification, and SSL.
 *
 * Grounded in apps/api/src/modules/domains/domain.routes.ts (mounted at
 * /api/domains in app.ts). Each subcommand hits the real route:
 *   list        GET    /domains?projectId=<id>
 *   add         POST   /domains                 { projectId, hostname, isPrimary? }
 *   preview     POST   /domains/preview         { hostname }
 *   check       POST   /domains/check           { hostname }  live DNS probe, no write
 *   verify      POST   /domains/:id/verify      (200 verified | 422 not-yet)
 *   primary     POST   /domains/:id/primary
 *   records     GET    /domains/:id/records
 *   renew       POST   /domains/:id/renew
 *   verify-ssl  POST   /domains/:id/verify-ssl
 *   renew-all   POST   /domains/renew-all
 */

import { Command } from "commander";
import chalk from "chalk";
import ora, { type Ora } from "ora";
import { apiRaw, apiRequest, ApiError } from "../lib/api-client";
import { printJson, printTable, isJsonMode, ok, err, info } from "../lib/output";

// ─── Shapes (subset of @repo/db Domain we render) ────────────────────────────

interface DomainRow {
  id: string;
  hostname: string;
  domainType?: string;
  isPrimary?: boolean;
  verified?: boolean;
  status?: string;
  sslStatus?: string | null;
  sslExpiresAt?: string | null;
}

interface DnsRecord {
  type: string;
  host: string;
  value: string;
}

interface RecordsResult {
  mode: "cloud" | "selfhosted";
  records: DnsRecord[];
}

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
  process.exit(1);
}

function domainRow(d: DomainRow): Record<string, unknown> {
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
function printRecords(result: RecordsResult): void {
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
      const res = await apiRequest<{ data: DomainRow[] }>(
        `/domains?projectId=${encodeURIComponent(opts.project)}`,
      );
      const rows = res.data ?? [];
      if (isJsonMode()) {
        printJson(rows);
        return;
      }
      printTable(rows.map(domainRow), ["id", "hostname", "type", "primary", "verified", "status", "ssl"]);
    } catch (e) {
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
      const res = await apiRequest<{ data: DomainRow; records: RecordsResult }>("/domains", {
        method: "POST",
        body: JSON.stringify({ projectId: opts.project, hostname, isPrimary: !!opts.primary }),
      });
      sp?.succeed(`Added ${res.data.hostname}`);
      if (isJsonMode()) {
        printJson({ domain: res.data, records: res.records });
        return;
      }
      info("  Add these DNS records at your registrar, then run `openship domain verify " + res.data.id + "`:");
      if (res.records) printRecords(res.records);
    } catch (e) {
      sp?.fail("Add failed");
      fail(e);
    }
  });

const previewCmd = new Command("preview")
  .description("Preview the DNS records a hostname would need (no changes saved)")
  .argument("<hostname>", "Domain hostname to preview")
  .action(async (hostname: string) => {
    try {
      const res = await apiRequest<{ data: RecordsResult }>("/domains/preview", {
        method: "POST",
        body: JSON.stringify({ hostname }),
      });
      printRecords(res.data);
    } catch (e) {
      fail(e);
    }
  });

const checkCmd = new Command("check")
  .description("Live-check whether the required DNS records already resolve (no changes saved)")
  .argument("<hostname>", "Domain hostname to check")
  .option("-p, --project <id>", "Project ID — used to fill the self-hosted A-record target")
  .option("--www", "Also check www.<hostname>", false)
  .action(async (hostname: string, opts: { project?: string; www?: boolean }) => {
    const sp = spin(`Checking DNS for ${hostname}…`);
    try {
      const res = await apiRequest<{
        data: {
          mode: string;
          allOk: boolean;
          records: Array<{ type: string; host: string; value: string; status: string; observed: string[] }>;
        };
      }>("/domains/check", {
        method: "POST",
        body: JSON.stringify({
          hostname,
          projectId: opts.project,
          includeWww: !!opts.www,
        }),
      });
      sp?.stop();
      if (isJsonMode()) {
        printJson(res.data);
        return;
      }
      info(`  DNS mode: ${res.data.mode}`);
      printTable(
        res.data.records.map((r) => ({
          status: r.status,
          type: r.type,
          host: r.host,
          value: r.value,
          observed: r.observed.join(", ") || "—",
        })),
        ["status", "type", "host", "value", "observed"],
      );
      if (res.data.allOk) {
        ok("  All records resolve.");
      } else {
        err("  Some records are missing or don't match yet.");
        process.exit(1);
      }
    } catch (e) {
      sp?.fail("DNS check failed");
      fail(e);
    }
  });

const verifyCmd = new Command("verify")
  .description("Run DNS verification for a domain")
  .argument("<id>", "Domain ID")
  .action(async (id: string) => {
    const sp = spin("Checking DNS records…");
    try {
      // The API returns 422 (not an error condition) when DNS isn't propagated
      // yet, with the same result body as a 200. Use apiRaw so both are handled
      // without throwing; anything else (401/404/500) is a real failure.
      const res = await apiRaw(`/domains/${encodeURIComponent(id)}/verify`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as {
        verified?: boolean;
        cnameVerified?: boolean;
        txtVerified?: boolean;
        message?: string;
        sslStatus?: string;
        error?: string;
      };
      if (!res.ok && res.status !== 422) {
        throw new ApiError(body.error || body.message || `API error: ${res.status}`, res.status, body);
      }
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
      if (!body.verified) process.exit(1);
    } catch (e) {
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
      const res = await apiRequest<{ data: DomainRow }>(`/domains/${encodeURIComponent(id)}/primary`, {
        method: "POST",
      });
      sp?.succeed(`${res.data.hostname} is now primary`);
      if (isJsonMode()) printJson(res.data);
    } catch (e) {
      sp?.fail("Failed to set primary");
      fail(e);
    }
  });

const recordsCmd = new Command("records")
  .description("Show the DNS records for an existing domain")
  .argument("<id>", "Domain ID")
  .action(async (id: string) => {
    try {
      const res = await apiRequest<{ data: RecordsResult }>(`/domains/${encodeURIComponent(id)}/records`);
      printRecords(res.data);
    } catch (e) {
      fail(e);
    }
  });

interface SslResult {
  domain: string;
  sslStatus: string;
  expiresAt?: string | null;
  issuer?: string | null;
  verified?: boolean;
}

function printSsl(data: SslResult): void {
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
      const res = await apiRequest<{ data: SslResult }>(`/domains/${encodeURIComponent(id)}/renew`, {
        method: "POST",
      });
      sp?.succeed(`Renewed ${res.data.domain}`);
      printSsl(res.data);
    } catch (e) {
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
      const res = await apiRequest<{ data: SslResult }>(`/domains/${encodeURIComponent(id)}/verify-ssl`, {
        method: "POST",
      });
      if (res.data.verified) sp?.succeed(`Certificate valid for ${res.data.domain}`);
      else sp?.fail(`Certificate not valid yet for ${res.data.domain}`);
      printSsl(res.data);
      if (!isJsonMode() && !res.data.verified) process.exit(1);
    } catch (e) {
      sp?.fail("SSL check failed");
      fail(e);
    }
  });

interface RenewAllResult {
  renewed: number;
  results: Array<{ domain: string; status: string; error?: string }>;
}

const renewAllCmd = new Command("renew-all")
  .description("Renew SSL for every near-expiry domain in your organization")
  .action(async () => {
    const sp = spin("Renewing expiring certificates…");
    try {
      const res = await apiRequest<{ data: RenewAllResult }>("/domains/renew-all", { method: "POST" });
      sp?.succeed(`Renewed ${res.data.renewed} domain(s)`);
      if (isJsonMode()) {
        printJson(res.data);
        return;
      }
      if (res.data.results.length > 0) {
        printTable(
          res.data.results.map((r) => ({ domain: r.domain, status: r.status, error: r.error ?? "" })),
          ["domain", "status", "error"],
        );
      } else {
        info("  Nothing needed renewal.");
      }
    } catch (e) {
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
  .addCommand(checkCmd)
  .addCommand(verifyCmd)
  .addCommand(primaryCmd)
  .addCommand(recordsCmd)
  .addCommand(renewCmd)
  .addCommand(verifySslCmd)
  .addCommand(renewAllCmd);
