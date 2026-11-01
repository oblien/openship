import { Command, Option } from "commander";
import { MailRequestSchemas as input, parseInput } from "@repo/contracts";
import { getRemoteClient } from "../lib/ship-client";
import { fetchCaps, requireSelfHost } from "../lib/caps";
import { confirmOrExit, printResult } from "../lib/cmd-helpers";
import { jsonCommand, jsonResourceCommand, jsonChildResourceCommand } from "../lib/json-command";

async function mail() {
  requireSelfHost(await fetchCaps());
  return getRemoteClient().mail;
}

/** Mail's controllers own authorization and lifecycle; these commands only collect and display input. */
export function registerMailAdminCommands(parent: Command): void {
  const domain = parent
    .command("domain")
    .description("Manage mail domains, their dependencies and DNS");
  domain
    .command("list")
    .argument("<server>")
    .description("List configured mail domains")
    .action((id: string) => printResult(async () => (await mail()).listDomains(id)));
  jsonResourceCommand(
    domain.command("create").description("Create a domain; inspect any returned DNS warning"),
    input.createDomain,
    async (id, value) => (await mail()).createDomain(id, value),
  );
  jsonChildResourceCommand(
    domain.command("update").description("Update domain capacity and enabled state"),
    input.updateDomain,
    async (id, name, value) => (await mail()).updateDomain(id, name, value),
  );
  for (const [name, method, description] of [
    ["get", "getDomain", "Read a mail domain"],
    ["dependents", "domainDependents", "Count affected mailboxes and aliases before deletion"],
    ["dns", "getDomainDns", "Read required records and their acknowledgment"],
    ["dns-plan", "planDomainDns", "Preview DNS changes without writing records"],
  ] as const) {
    domain
      .command(name)
      .argument("<server>")
      .argument("<domain>")
      .description(description)
      .action((id: string, name: string) =>
        printResult(async () => (await mail())[method](id, name)),
      );
  }
  for (const [name, method, description] of [
    ["dns-apply", "applyDomainDns", "Apply the domain's DNS records using its connected provider"],
    ["dns-ack", "acknowledgeDomainDns", "Confirm that you have published the required records"],
  ] as const) {
    domain
      .command(name)
      .argument("<server>")
      .argument("<domain>")
      .description(description)
      .option("-y, --yes", "Confirm DNS operation")
      .action((id: string, name: string, opts) =>
        printResult(async () => {
          await confirmOrExit(opts.yes, `${description} for ${name}?`);
          const result = await (await mail())[method](id, name);
          if ("provisioned" in result && !result.provisioned) process.exitCode = 1;
          return result;
        }),
      );
  }
  domain
    .command("pending-dns")
    .argument("<server>")
    .description("List domains still needing DNS configuration")
    .action((id: string) => printResult(async () => (await mail()).pendingDomainDns(id)));
  domain
    .command("remove")
    .argument("<server>")
    .argument("<domain>")
    .description("Delete a domain; --cascade also deletes dependent accounts")
    .option("--cascade", "Also remove dependent mailboxes and aliases")
    .option("-y, --yes", "Confirm deletion")
    .action((id: string, name: string, opts) =>
      printResult(async () => {
        await confirmOrExit(
          opts.yes,
          `Delete ${name}${opts.cascade ? " and its mailboxes and aliases" : ""}?`,
        );
        return (await mail()).removeDomain(id, name, { cascade: !!opts.cascade });
      }),
    );

  const mailbox = parent
    .command("mailbox")
    .description("Manage mailbox accounts and storage limits");
  mailbox
    .command("list")
    .argument("<server>")
    .requiredOption("--domain <domain>", "Mail domain")
    .description("List mailboxes for a domain without passwords")
    .action((id: string, opts) =>
      printResult(async () => (await mail()).listMailboxes(id, { domain: opts.domain })),
    );
  mailbox
    .command("get")
    .argument("<server>")
    .argument("<email>")
    .description("Read mailbox configuration")
    .action((id: string, email: string) =>
      printResult(async () => (await mail()).getMailbox(id, email)),
    );
  jsonResourceCommand(
    mailbox
      .command("create")
      .description("Create an account; read its password from JSON file or stdin"),
    input.createMailbox,
    async (id, value) => (await mail()).createMailbox(id, value),
  );
  jsonChildResourceCommand(
    mailbox.command("update").description("Update a mailbox; omit password to preserve it"),
    input.updateMailbox,
    async (id, email, value) => (await mail()).updateMailbox(id, email, value),
  );
  mailbox
    .command("remove")
    .argument("<server>")
    .argument("<email>")
    .description("Remove an account; retain stored mail unless --hard is supplied")
    .option("--hard", "Permanently delete stored mail too")
    .option("-y, --yes", "Confirm removal")
    .action((id: string, email: string, opts) =>
      printResult(async () => {
        await confirmOrExit(
          opts.yes,
          `Remove ${email}${opts.hard ? " and permanently delete its mail" : " (retain mail data)"}?`,
        );
        return (await mail()).removeMailbox(id, email, { hard: !!opts.hard });
      }),
    );

  const alias = parent.command("alias").description("Manage forwards and catch-all addresses");
  alias
    .command("list")
    .argument("<server>")
    .requiredOption("--domain <domain>", "Mail domain")
    .description("List aliases for a domain")
    .action((id: string, opts) =>
      printResult(async () => (await mail()).listAliases(id, { domain: opts.domain })),
    );
  jsonResourceCommand(
    alias.command("create").description("Create a forwarding or catch-all address"),
    input.createAlias,
    async (id, value) => (await mail()).createAlias(id, value),
  );
  jsonChildResourceCommand(
    alias.command("update").description("Enable or disable an alias"),
    input.updateAlias,
    async (id, aliasId, value) => (await mail()).updateAlias(id, aliasId, value),
  );
  alias
    .command("remove")
    .argument("<server>")
    .argument("<alias>")
    .option("-y, --yes", "Confirm removal")
    .description("Remove an alias by its numeric ID")
    .action((id: string, aliasId: string, opts) =>
      printResult(async () => {
        await confirmOrExit(opts.yes, `Remove alias ${aliasId}?`);
        return (await mail()).removeAlias(id, aliasId);
      }),
    );

  const cert = parent
    .command("certificate")
    .description("Inspect and renew mail TLS through Openship's shared edge");
  for (const [name, method] of [
    ["get", "getCertificate"],
    ["check", "checkCertificate"],
    ["renew", "renewCertificate"],
  ] as const) {
    cert
      .command(name)
      .argument("<server>")
      .description(
        name === "renew"
          ? "Renew a due certificate and reload SMTP/IMAP through the existing edge workflow"
          : `${name} mail certificate status`,
      )
      .action((id: string) => printResult(async () => (await mail())[method](id)));
  }
  cert
    .command("auto-renew")
    .argument("<server>")
    .addOption(
      new Option("--state <state>", "Automatic renewal")
        .choices(["on", "off"])
        .makeOptionMandatory(),
    )
    .description("Enable or disable scheduled renewal; monitoring remains available")
    .action((id: string, opts) =>
      printResult(async () =>
        (await mail()).updateCertificate(id, { autoRenew: opts.state === "on" }),
      ),
    );

  const relay = parent
    .command("relay")
    .description("Manage outbound SMTP delivery without exposing stored passwords");
  relay
    .command("get")
    .argument("<server>")
    .description("Read masked relay settings")
    .action((id: string) => printResult(async () => (await mail()).getRelay(id)));
  jsonResourceCommand(
    relay
      .command("configure")
      .description("Configure outbound SMTP; omit password to keep the saved one"),
    input.configureRelay,
    async (id, value) => (await mail()).configureRelay(id, value),
    "Change outbound mail delivery?",
  );
  relay
    .command("remove")
    .argument("<server>")
    .option("-y, --yes", "Confirm direct delivery")
    .description("Disable the relay and return to direct SMTP delivery")
    .action((id: string, opts) =>
      printResult(async () => {
        await confirmOrExit(opts.yes, `Disable ${id}'s relay and use direct delivery?`);
        return (await mail()).removeRelay(id);
      }),
    );

  const backup = parent
    .command("backup")
    .description("Manage mail backup policy; use openship backup for runs and restores");
  backup
    .command("get")
    .argument("<server>")
    .description("Read the current mail backup policy")
    .action((id: string) => printResult(async () => (await mail()).getBackupPolicy(id)));
  jsonResourceCommand(
    backup
      .command("configure")
      .description(
        "Set destination, schedule and included mail data; omitted retention is preserved",
      ),
    input.saveBackupPolicy,
    async (id, value) => (await mail()).saveBackupPolicy(id, value),
  );
  backup
    .command("runs")
    .argument("<server>")
    .description("Read the 50 most recent mail backup runs")
    .action((id: string) => printResult(async () => (await mail()).listBackupRuns(id)));

  const inbound = parent.command("inbound").description("Manage inbound-mail notification rules");
  inbound
    .command("list")
    .argument("<server>")
    .description("List rules and paused state")
    .action((id: string) => printResult(async () => (await mail()).listInboundRules(id)));
  jsonResourceCommand(
    inbound.command("create").description("Create a rule for existing notification channels"),
    input.createInboundRule,
    async (id, value) => (await mail()).createInboundRule(id, value),
  );
  jsonChildResourceCommand(
    inbound
      .command("update")
      .description("Update a rule; pausedReason=null explicitly clears its pause"),
    input.updateInboundRule,
    async (id, ruleId, value) => (await mail()).updateInboundRule(id, ruleId, value),
  );
  inbound
    .command("remove")
    .argument("<server>")
    .argument("<rule>")
    .option("-y, --yes", "Confirm removal")
    .description("Remove a rule and release unneeded capture")
    .action((id: string, ruleId: string, opts) =>
      printResult(async () => {
        await confirmOrExit(opts.yes, `Remove inbound rule ${ruleId}?`);
        return (await mail()).removeInboundRule(id, ruleId);
      }),
    );
  inbound
    .command("test")
    .argument("<server>")
    .description("Preview matches without sending notifications or deleting captured mail")
    .action((id: string) =>
      printResult(async () => {
        const result = await (await mail()).testInboundRules(id);
        if (result.errors.length) process.exitCode = 1;
        return result;
      }),
    );

  parent
    .command("stats")
    .argument("<server>")
    .description("Read domain, account and storage totals")
    .action((id: string) => printResult(async () => (await mail()).getStats(id)));
  parent
    .command("dns-scan")
    .argument("<server>")
    .option("--domain <domain>", "Domain to inspect")
    .description("Inspect mail DNS without changing records")
    .action((id: string, opts) =>
      printResult(async () => (await mail()).scanDns(id, { domain: opts.domain })),
    );
  parent
    .command("test-email")
    .argument("<server>")
    .requiredOption("--to <email>", "Recipient for one real test message")
    .option("--from-domain <domain>", "Sender's configured mail domain")
    .description("Send one delivery test to the specified recipient")
    .action((id: string, opts) =>
      printResult(async () =>
        (await mail()).sendTestEmail(id, { to: opts.to, fromDomain: opts.fromDomain }),
      ),
    );
  parent
    .command("rotate-platform-mailbox")
    .argument("<server>")
    .option("-y, --yes", "Confirm rotation")
    .description("Rotate Openship's private delivery credential; never prints its password")
    .action((id: string, opts) =>
      printResult(async () => {
        await confirmOrExit(opts.yes, `Rotate the platform delivery credential on ${id}?`);
        return (await mail()).rotatePlatformMailbox(id);
      }),
    );
  parent
    .command("component")
    .argument("<server>")
    .argument("<key>")
    .argument("<action>", "start, stop, or restart")
    .description("Control a managed mail component; inspect health to confirm recovery")
    .option("-y, --yes", "Confirm component action")
    .action((id: string, key: string, action: string, opts) =>
      printResult(async () => {
        const value = parseInput(input.componentAction, { action });
        await confirmOrExit(opts.yes, `${action} ${key} on ${id}?`);
        return (await mail()).componentAction(id, key, value);
      }),
    );
  parent
    .command("restart-all")
    .argument("<server>")
    .option("-y, --yes", "Confirm restart")
    .description("Restart managed mail components; delivery may be briefly interrupted")
    .action((id: string, opts) =>
      printResult(async () => {
        await confirmOrExit(opts.yes, `Restart mail components on ${id}?`);
        const result = await (await mail()).restartComponents(id);
        if (result.results.some((item) => !item.ok)) process.exitCode = 1;
        return result;
      }),
    );

  const webmail = parent
    .command("webmail")
    .description("Deploy webmail through the normal app deployment workflow");
  webmail
    .command("targets")
    .argument("<server>")
    .description("List permitted targets for this mail server")
    .action((serverId: string) =>
      printResult(async () => (await mail()).getWebmailTargets({ serverId })),
    );
  jsonCommand(
    webmail
      .command("deploy")
      .description("Deploy webmail and return IDs for openship deployment wait/logs"),
    input.deployWebmail,
    async (value) => (await mail()).deployWebmail(value),
    "Deploy webmail (replaceLegacy=true explicitly replaces the legacy install)?",
  );
  jsonCommand(
    webmail
      .command("deploy-external")
      .description("Deploy webmail for an external IMAP/SMTP provider"),
    input.deployExternalWebmail,
    async (value) => (await mail()).deployExternalWebmail(value),
  );
}
