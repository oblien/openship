import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { exitCommand, rethrowCommandExit } from "../lib/command-exit";
/**
 * SYSTEM / LIFECYCLE commands — self-hosted only.
 *
 * Every subcommand maps 1:1 to a route in the API `system` module
 * (apps/api/src/modules/system/system.routes.ts, mounted at /api/system and
 * gated by `localOnly`). We gate client-side with requireSelfHost so cloud
 * targets get a clean message instead of a 404.
 */
import { Command, Option } from "commander";
import type { UpdateInstanceSettingsInput } from "@repo/sdk";
import ora, { type Ora } from "ora";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { getRemoteClient, getShipClient } from "../lib/ship-client";
import { fetchCaps, requireSelfHost } from "../lib/caps";
import { printJson, printTable, isJsonMode, ok, info, err } from "../lib/output";
import { SystemOperationSchemas, InstanceOperationSchemas, InstanceOnboardingSchema, InstanceArchiveSchema, InstanceExportSelectionSchema, InstanceImportSelectionSchema, parseInput } from "@repo/contracts";
import { readJsonInput, readSecret } from "../lib/command-input";
import { confirmOrExit, printResult, fail } from "../lib/cmd-helpers";
import { jsonCommand } from "../lib/json-command";

/** Domain target for the "own server" migration path (preflight + start). */
type DomainChoice =
  | { kind: "custom"; hostname: string }
  | { kind: "free"; slug: string };

/**
 * Gate + run a self-host command. Discovers caps once, refuses on cloud, and
 * turns any ApiError into a clean stderr message + non-zero exit.
 */
async function guarded(fn: () => Promise<void>): Promise<void> {
  try {
    requireSelfHost(await fetchCaps());
    await fn();
  } catch (e) {
    observeCaughtError(e, "cli/commands/system");
    fail(e);
  }
}

/** Emit structured JSON in --json mode, otherwise run the human renderer. */
function report(obj: unknown, human: () => void): void {
  if (isJsonMode()) printJson(obj);
  else human();
}

function spinner(text: string): Ora | null {
  return isJsonMode() ? null : ora(text).start();
}

async function confirm(message: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY || isJsonMode()) return false;
  const rl = createInterface({ input, output });
  const ans = (await rl.question(`  ${message} (y/N): `)).trim().toLowerCase();
  rl.close();
  return ans === "y" || ans === "yes";
}

/** Prompt without echoing keystrokes (password entry). Native readline only. */
async function promptHidden(query: string): Promise<string> {
  const rl = createInterface({ input, output });
  const iface = rl as unknown as { _writeToOutput: (s: string) => void };
  let muted = false;
  iface._writeToOutput = (s: string) => {
    if (!muted || /[\r\n]/.test(s)) output.write(s);
  };
  const pending = rl.question(query);
  muted = true; // prompt already written synchronously; mute the typed chars
  const answer = await pending;
  rl.close();
  output.write("\n");
  return answer;
}

/* ── settings get / set ─────────────────────────────────────────────
 * GET  /api/system/settings  → setup.getSetup
 * PATCH /api/system/settings → setup.updateSettings
 */
const settingsCommand = new Command("settings").description("Read or update instance settings");
jsonCommand(settingsCommand.command("patch").description("Update any supported instance setting using its shared JSON contract"),
  SystemOperationSchemas.updateSettings.input, value => getShipClient().system.updateSettings(value));
settingsCommand.command("reset").description("Reset instance settings and return to setup")
  .option("-y, --yes", "Confirm the instance reset")
  .action(opts => printResult(async () => {
    await confirmOrExit(opts.yes, "Reset this instance's settings and setup state?");
    return getShipClient().system.resetSettings();
  }));

settingsCommand
  .command("get")
  .description("Show current instance settings")
  .action(async () => {
    await guarded(async () => {
      const s = await getShipClient().system.getSettings();
      report(s, () =>
        printTable(
          Object.entries(s).map(([key, value]) => ({ setting: key, value: value ?? "" })),
          ["setting", "value"],
        ),
      );
    });
  });

settingsCommand
  .command("set")
  .description("Update instance-level settings")
  .option("--auth-mode <mode>", "Auth mode: none | local | cloud")
  .option("--confirm <phrase>", 'Required for auth-mode none: "I-understand-no-auth"')
  .option("--tunnel-provider <provider>", "Tunnel provider (empty string clears)")
  .option("--tunnel-token <token>", "Tunnel token")
  .option("--default-build-mode <mode>", "Default build mode")
  .option("--default-rollback-window <n>", "Default rollback window")
  .option("--invitation-mail-source <src>", "Invitation mail source: platform | cloud")
  .action(async (opts) => {
    await guarded(async () => {
      const body: UpdateInstanceSettingsInput = {};
      if (opts.authMode !== undefined) body.authMode = opts.authMode;
      if (opts.confirm !== undefined) body.confirm = opts.confirm;
      if (opts.tunnelProvider !== undefined) body.tunnelProvider = opts.tunnelProvider;
      if (opts.tunnelToken !== undefined) body.tunnelToken = opts.tunnelToken;
      if (opts.defaultBuildMode !== undefined) body.defaultBuildMode = opts.defaultBuildMode;
      if (opts.defaultRollbackWindow !== undefined)
        body.defaultRollbackWindow = opts.defaultRollbackWindow;
      if (opts.invitationMailSource !== undefined)
        body.invitationMailSource = opts.invitationMailSource;

      const settable = Object.keys(body).filter((k) => k !== "confirm");
      if (settable.length === 0) {
        err("\n  Nothing to update. Pass at least one field (see --help).\n");
        exitCommand(1);
      }

      const res = await getShipClient().system.updateSettings(body);
      report(res, () => ok(`\n  Settings updated (${settable.join(", ")}).\n`));
    });
  });

/* ── onboarding apply ────────────────────────────────────────────────
 * POST /api/system/onboarding → setup.onboardingSetup (public, first-run only).
 * Persists instance settings + creates the initial SSH server row.
 */
const onboardingCommand = new Command("onboarding").description("First-run instance setup");

onboardingCommand.command("status").description("Check whether the controller has completed first-run setup")
  .action(() => printResult(() => getRemoteClient().instance.onboardingStatus()));

onboardingCommand
  .command("apply")
  .description("Configure a fresh instance (fails once already configured)")
  .option("--ssh-host <host>", "SSH host of the target server")
  .option("--ssh-port <n>", "SSH port (default 22)")
  .option("--ssh-user <user>", "SSH user (default root)")
  .option("--ssh-auth-method <method>", "SSH auth method")
  .option("--ssh-password <password>", "SSH password")
  .option("--ssh-key-path <path>", "SSH private key path")
  .option("--ssh-key-passphrase <pass>", "SSH key passphrase")
  .option("--ssh-jump-host <host>", "SSH jump host")
  .option("--ssh-transport <transport>", "SSH transport (direct|cloudflare)")
  .option("--ssh-args <args>", "SSH connection tuning arguments")
  .option("--server-name <name>", "Display name for the server")
  .option("--auth-mode <mode>", "Initial auth mode: none | local | cloud")
  .option("--tunnel-provider <provider>", "Tunnel provider")
  .option("--tunnel-token <token>", "Tunnel token")
  .option("--default-build-mode <mode>", "Default build mode")
  .option("--default-rollback-window <n>", "Default rollback window")
  .action(async (opts) => {
    await guarded(async () => {
      const body: Record<string, unknown> = {
        authMode: opts.authMode,
        tunnelProvider: opts.tunnelProvider,
        tunnelToken: opts.tunnelToken,
        defaultBuildMode: opts.defaultBuildMode,
        defaultRollbackWindow: opts.defaultRollbackWindow,
        serverName: opts.serverName,
        sshHost: opts.sshHost,
        sshPort: opts.sshPort ? Number(opts.sshPort) : undefined,
        sshUser: opts.sshUser,
        sshAuthMethod: opts.sshAuthMethod,
        sshPassword: opts.sshPassword,
        sshKeyPath: opts.sshKeyPath,
        sshKeyPassphrase: opts.sshKeyPassphrase,
        sshJumpHost: opts.sshJumpHost,
        sshTransport: opts.sshTransport,
        sshArgs: opts.sshArgs,
      };

      const spin = spinner("Applying onboarding…");
      try {
        const res = await getRemoteClient().instance.configureOnboarding(parseInput(InstanceOnboardingSchema, body));
        spin?.succeed("Onboarding applied.");
        report(res, () => ok("\n  Instance configured.\n"));
      } catch (e) {
      rethrowCommandExit(e);
        spin?.fail("Onboarding failed.");
        throw e;
      }
    });
  });

/* ── upgrade-to-auth ─────────────────────────────────────────────────
 * POST /api/system/upgrade-to-auth → setup.upgradeToAuth (public; only valid
 * while authMode === "none"). Promotes the synthetic zero-auth user to a real
 * email/password account.
 */
const upgradeToAuthCommand = new Command("upgrade-to-auth")
  .description("Promote a zero-auth instance to email/password login")
  .option("--name <name>", "Account display name")
  .option("--email <email>", "Account email")
  .option("--password <password>", "Account password (prompted if omitted)")
  .option("--use-own-mail-server", "Warm the self-hosted mail server for auth emails")
  .action(async (opts) => {
    await guarded(async () => {
      const name: string | undefined = opts.name;
      const email: string | undefined = opts.email;
      let password: string | undefined = opts.password;

      if (!password) {
        if (!process.stdin.isTTY || isJsonMode()) {
          err("\n  --password is required in non-interactive mode.\n");
          exitCommand(1);
        }
        password = await promptHidden("  New password: ");
      }

      const res = await getRemoteClient().instance.upgradeToAuth(parseInput(InstanceOperationSchemas.upgradeToAuth.input, {
        name, email, password, useOwnMailServer: opts.useOwnMailServer === true,
      }));
      report(res, () => ok(`\n  Upgraded to ${res.authMode} auth. Sign in with ${email}.\n`));
    });
  });

/* ── browse ──────────────────────────────────────────────────────────
 * GET /api/system/browse?path=<dir> → filesystem.browse. Lists child
 * directories (projects first) so you can pick a folder to deploy.
 */
const browseCommand = new Command("browse")
  .description("List directories on the instance host (defaults to home)")
  .argument("[path]", "Directory to list")
  .action(async (path?: string) => {
    await guarded(async () => {
      const res = await getShipClient().system.browse({ path });
      report(res, () => {
        info(`\n  ${res.path}\n`);
        printTable(
          res.directories.map((d) => ({
            name: d.name,
            project: d.isProject ? "yes" : "",
            path: d.path,
          })),
          ["name", "project", "path"],
        );
      });
    });
  });

/* ── migration ───────────────────────────────────────────────────────
 * POST /api/system/migration/{preflight,start,start-cloud,start-tunnel,switch-back}
 * → migration.controller. Preflight/start move a single-user instance onto the
 * operator's own server; start-cloud → Openship Cloud; start-tunnel → edge
 * tunnel; switch-back reverses any of them.
 */
function buildDomain(opts: { hostname?: string; slug?: string }): DomainChoice {
  if (opts.hostname && opts.slug) {
    err("\n  Pass either --hostname (custom) or --slug (free), not both.\n");
    exitCommand(1);
  }
  if (opts.hostname) return { kind: "custom", hostname: opts.hostname };
  if (opts.slug) return { kind: "free", slug: opts.slug };
  err("\n  A domain is required: pass --hostname <host> or --slug <slug>.\n");
  exitCommand(1);
}

const migrationCommand = new Command("migration").description("Team-mode migration lifecycle");

migrationCommand
  .command("preflight")
  .description("Read-only readiness check for the own-server migration")
  .requiredOption("--server-id <id>", "Target server id")
  .option("--hostname <host>", "Custom domain pointing at the server")
  .option("--slug <slug>", "Free <slug>.opsh.io subdomain")
  .action(async (opts) => {
    await guarded(async () => {
      const domain = buildDomain(opts);
      const res = await getRemoteClient().instance.preflightMigration({ serverId: opts.serverId, domain });
      if (!res.ready) process.exitCode = 1;
      report(res, () => {
        printTable(
          Object.entries(res.checks).map(([check, v]) => ({
            check,
            ok: v.ok ? "pass" : "FAIL",
            detail: v.detail,
          })),
          ["check", "ok", "detail"],
        );
        (res.ready ? ok : err)(`\n  Ready: ${res.ready}\n`);
      });
    });
  });

migrationCommand
  .command("start")
  .description("Earlier migration endpoint; use Settings → Instance → Instance location to move")
  .requiredOption("--server-id <id>", "Target server id")
  .option("--hostname <host>", "Custom domain pointing at the server")
  .option("--slug <slug>", "Free <slug>.opsh.io subdomain")
  .action(async (opts) => {
    await guarded(async () => {
      const domain = buildDomain(opts);
      const spin = spinner("Migrating to server…");
      try {
        const res = await getRemoteClient().instance.migrateToServer({ serverId: opts.serverId, domain });
        spin?.succeed("Migration complete.");
        report(res, () => ok(`\n  Now serving at ${res.migrationTargetUrl}\n`));
      } catch (e) {
      rethrowCommandExit(e);
        spin?.fail("Migration failed.");
        throw e;
      }
    });
  });

migrationCommand
  .command("start-cloud")
  .description("Migrate this instance to Openship Cloud")
  .option("--allow-non-empty-target", "Proceed even if the cloud org already has projects")
  .action(async (opts) => {
    await guarded(async () => {
      const spin = spinner("Migrating to Openship Cloud…");
      try {
        const res = await getRemoteClient().instance.migrateToCloud({ allowNonEmptyTarget: opts.allowNonEmptyTarget === true });
        spin?.succeed("Cloud migration complete.");
        report(res, () => ok(`\n  Now hosted at ${res.publicUrl}\n`));
      } catch (e) {
      rethrowCommandExit(e);
        spin?.fail("Cloud migration failed.");
        throw e;
      }
    });
  });

migrationCommand
  .command("start-tunnel")
  .description("Expose this instance via an edge tunnel")
  .requiredOption("--slug <slug>", "Tunnel slug")
  .action(async (opts) => {
    await guarded(async () => {
      const spin = spinner("Provisioning tunnel…");
      try {
        const res = await getRemoteClient().instance.exposeTunnel({ slug: opts.slug });
        spin?.succeed("Tunnel active.");
        report(res, () => ok(`\n  Now reachable at ${res.migrationTargetUrl}\n`));
      } catch (e) {
      rethrowCommandExit(e);
        spin?.fail("Tunnel provisioning failed.");
        throw e;
      }
    });
  });

migrationCommand
  .command("switch-back")
  .description("Reverse migration back to single-user (teammates lose access)")
  .option("--abandon-remote", "Skip pulling remote data; keep the local DB as-is")
  .option("-y, --yes", "Skip the confirmation prompt")
  .action(async (opts) => {
    await guarded(async () => {
      if (!(await confirm("Switch back to single-user? Teammates will lose access.", opts.yes))) {
        err("\n  Aborted.\n");
        exitCommand(1);
      }
      const spin = spinner("Switching back…");
      try {
        const res = await getRemoteClient().instance.switchBack({ abandonRemote: opts.abandonRemote === true });
        spin?.succeed("Switched back to single-user.");
        report(res, () =>
          ok(
            `\n  Reversed ${res.previousMode}. ` +
              (res.syncedFromRemote ? `${res.rowsRestored} rows restored.` : "Kept local data.") +
              "\n",
          ),
        );
      } catch (e) {
      rethrowCommandExit(e);
        spin?.fail("Switch-back failed.");
        throw e;
      }
    });
  });

/* ── data-transfer export / import ───────────────────────────────────
 * POST /api/system/data-transfer/{export,import} → data-transfer.controller
 * (instance-admin only). Current exports include plaintext credentials; imports
 * also accept older sealed archives. Import defaults to explicitly confirmed wipe mode.
 */
const dataTransferCommand = new Command("data-transfer").description(
  "Instance and project data export / import (instance-admin only)",
);

jsonCommand(dataTransferCommand.command("preview").description("Review export row counts, scope, projects and credentials before exporting"),
  InstanceOperationSchemas.previewExport.input, input => getRemoteClient().instance.previewExport(input));

dataTransferCommand
  .command("export")
  .description("Export instance or project data, including plaintext credentials, to a private JSON file")
  .option("--selection <file>", "Export selection as JSON, or - for stdin")
  .option("--out <file>", "Write the export to this file instead of stdout")
  .action(async (opts) => {
    await guarded(async () => {
      const selection = opts.selection ? parseInput(InstanceExportSelectionSchema, readJsonInput(opts.selection)) : undefined;
      if (opts.out && existsSync(opts.out)) throw new Error(`Output file already exists: ${opts.out}. Choose a new filename.`);
      const spin = spinner("Exporting instance…");
      try {
        const file = await getRemoteClient().instance.exportData({ selection });
        spin?.succeed("Export ready.");
        if (opts.out) {
          writeFileSync(opts.out, JSON.stringify(file), { mode: 0o600, flag: "wx" });
          const tables = Object.keys(file.dump?.tables ?? {}).length;
          report({ out: opts.out, tables }, () =>
            ok(`\n  Wrote ${tables} tables to ${opts.out}\n`),
          );
        } else {
          printJson(file);
        }
      } catch (e) {
      rethrowCommandExit(e);
        spin?.fail("Export failed.");
        throw e;
      }
    });
  });

dataTransferCommand
  .command("import")
  .description("Import an instance export file")
  .requiredOption("--file <path>", "Path to an export file")
  .addOption(new Option("--passphrase <passphrase>", "Passphrase for a legacy encrypted export").conflicts("passphraseFile"))
  .option("--passphrase-file <file>", "Legacy passphrase file, or - for stdin")
  .option("--selection <file>", "Import selection and reviewed server mappings as JSON")
  .addOption(new Option("--mode <mode>", "wipe (replace) | merge").choices(["wipe", "merge"]).default("wipe"))
  .option("-y, --yes", "Skip the confirmation prompt")
  .action(async (opts) => {
    await guarded(async () => {
      const mode: "wipe" | "merge" = opts.mode;
      const selection = opts.selection ? parseInput(InstanceImportSelectionSchema, readJsonInput(opts.selection)) : undefined;
      const passphrase = opts.passphraseFile ? readSecret(opts.passphraseFile) : opts.passphrase;
      if (mode === "wipe" && !(await confirm("Wipe this instance and import the file?", opts.yes))) {
        err("\n  Aborted.\n");
        exitCommand(1);
      }

      let file: unknown;
      try {
        file = JSON.parse(readFileSync(opts.file, "utf8"));
      } catch {
        err(`\n  Could not read or parse ${opts.file}.\n`);
        exitCommand(1);
      }

      const spin = spinner("Importing instance…");
      try {
        const res = await getRemoteClient().instance.importData({ file: parseInput(InstanceArchiveSchema, file), passphrase, mode, selection });
        spin?.succeed("Import complete.");
        report(res, () => {
          ok(
            `\n  Imported ${res.rowsRestored} rows (${res.mode}). ` +
              `${res.secretsRehydrated} secrets rehydrated${res.secretsSkipped ? ", secrets skipped" : ""}.\n`,
          );
          const lp = res.localPathProjects ?? [];
          if (lp.length > 0) {
            err(
              `\n  ⚠  ${lp.length} project(s) deploy from a local folder on the SOURCE machine — that path\n` +
                `     won't exist here. Re-point localPath (or re-deploy from a folder on this machine):\n` +
                lp.map((p) => `       • ${p.slug}  (${p.localPath})`).join("\n") +
                "\n",
            );
          }
        });
      } catch (e) {
      rethrowCommandExit(e);
        spin?.fail("Import failed.");
        throw e;
      }
    });
  });

/* ── parent ──────────────────────────────────────────────────────────── */
export const systemCommand = new Command("system")
  .description("Instance settings, onboarding, migration, and data transfer")
  .addCommand(settingsCommand)
  .addCommand(onboardingCommand)
  .addCommand(upgradeToAuthCommand)
  .addCommand(browseCommand)
  .addCommand(migrationCommand)
  .addCommand(dataTransferCommand);

systemCommand.command("info").description("Read product mode, version and advertised capabilities")
  .action(() => printResult(() => getShipClient().system.info()));
systemCommand.command("notices").description("Read advisories for this instance and workspace")
  .action(() => printResult(() => getShipClient().notices.list()));
const email = new Command("email").description("Manage the instance's invitation and authentication email transport");
email.command("get").description("Read mail transport configuration with credentials masked")
  .action(() => printResult(() => getShipClient().system.getEmailSettings()));
jsonCommand(email.command("set").description("Update the instance's email transport credentials"),
  SystemOperationSchemas.updateEmailSettings.input, value => getShipClient().system.updateEmailSettings(value));
email.command("test").argument("<address>", "Recipient for one test message")
  .description("Send one test message through the configured mail transport")
  .action((to: string) => printResult(async () => {
    const result = await getShipClient().system.sendTestEmail({ to });
    if (!result.ok) process.exitCode = 1;
    return result;
  }));
systemCommand.addCommand(email);
const orphans = new Command("untracked-sites").description("Inspect edge sites not tracked by Openship");
orphans.command("list").description("Read untracked edge sites and scan readiness")
  .action(() => printResult(() => getShipClient().system.listUntrackedEdgeSites()));
orphans.command("remove").argument("<hostname>", "Exact hostname from the scan")
  .option("-y, --yes", "Confirm removal").description("Remove one untracked edge site through ownership checks")
  .action((hostname: string, opts) => printResult(async () => {
    await confirmOrExit(opts.yes, `Remove untracked edge site ${hostname}?`);
    return getShipClient().system.removeUntrackedEdgeSite({ hostname });
  }));
systemCommand.addCommand(orphans);
