/**
 * SYSTEM / LIFECYCLE commands — self-hosted only.
 *
 * Every subcommand maps 1:1 to a route in the API `system` module
 * (apps/api/src/modules/system/system.routes.ts, mounted at /api/system and
 * gated by `localOnly`). We gate client-side with requireSelfHost so cloud
 * targets get a clean message instead of a 404.
 */
import { Command } from "commander";
import ora, { type Ora } from "ora";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { apiRequest, ApiError } from "../lib/api-client";
import { fetchCaps, requireSelfHost } from "../lib/caps";
import { printJson, printTable, isJsonMode, ok, info, err } from "../lib/output";

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
    if (e instanceof ApiError) {
      err(`\n  ${e.message}\n`);
      process.exit(1);
    }
    throw e;
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
interface InstanceSettings {
  configured: boolean;
  authMode: string;
  tunnelProvider: string | null;
  defaultBuildMode: string;
  defaultRollbackWindow: unknown;
  invitationMailSource: string;
  teamMode: string;
  migrationTargetUrl: string | null;
  migratedAt: string | null;
}

const settingsCommand = new Command("settings").description("Read or update instance settings");

settingsCommand
  .command("get")
  .description("Show current instance settings")
  .action(async () => {
    await guarded(async () => {
      const s = await apiRequest<InstanceSettings>("/system/settings");
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
      const body: Record<string, unknown> = {};
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
        process.exit(1);
      }

      const res = await apiRequest<{ ok: true }>("/system/settings", {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      report(res, () => ok(`\n  Settings updated (${settable.join(", ")}).\n`));
    });
  });

/* ── onboarding apply ────────────────────────────────────────────────
 * POST /api/system/onboarding → setup.onboardingSetup (public, first-run only).
 * Persists instance settings + creates the initial SSH server row.
 */
const onboardingCommand = new Command("onboarding").description("First-run instance setup");

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
  .option("--ssh-args <args>", "Extra SSH args")
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
        sshArgs: opts.sshArgs,
      };

      const spin = spinner("Applying onboarding…");
      try {
        const res = await apiRequest<{ ok: true }>("/system/onboarding", {
          method: "POST",
          body: JSON.stringify(body),
        });
        spin?.succeed("Onboarding applied.");
        report(res, () => ok("\n  Instance configured.\n"));
      } catch (e) {
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
          process.exit(1);
        }
        password = await promptHidden("  New password: ");
      }

      const res = await apiRequest<{ ok: true; authMode: string; user: unknown }>(
        "/system/upgrade-to-auth",
        {
          method: "POST",
          body: JSON.stringify({
            name,
            email,
            password,
            useOwnMailServer: opts.useOwnMailServer === true,
          }),
        },
      );
      report(res, () => ok(`\n  Upgraded to ${res.authMode} auth. Sign in with ${email}.\n`));
    });
  });

/* ── browse ──────────────────────────────────────────────────────────
 * GET /api/system/browse?path=<dir> → filesystem.browse. Lists child
 * directories (projects first) so you can pick a folder to deploy.
 */
interface BrowseResult {
  path: string;
  directories: { name: string; path: string; isProject: boolean }[];
}

const browseCommand = new Command("browse")
  .description("List directories on the instance host (defaults to home)")
  .argument("[path]", "Directory to list")
  .action(async (path?: string) => {
    await guarded(async () => {
      const qs = path ? `?path=${encodeURIComponent(path)}` : "";
      const res = await apiRequest<BrowseResult>(`/system/browse${qs}`);
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
    process.exit(1);
  }
  if (opts.hostname) return { kind: "custom", hostname: opts.hostname };
  if (opts.slug) return { kind: "free", slug: opts.slug };
  err("\n  A domain is required: pass --hostname <host> or --slug <slug>.\n");
  process.exit(1);
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
      const res = await apiRequest<{
        ready: boolean;
        checks: Record<string, { ok: boolean; detail: string }>;
      }>("/system/migration/preflight", {
        method: "POST",
        body: JSON.stringify({ serverId: opts.serverId, domain }),
      });
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
  .description("Migrate this instance onto your own server")
  .requiredOption("--server-id <id>", "Target server id")
  .option("--hostname <host>", "Custom domain pointing at the server")
  .option("--slug <slug>", "Free <slug>.opsh.io subdomain")
  .action(async (opts) => {
    await guarded(async () => {
      const domain = buildDomain(opts);
      const spin = spinner("Migrating to server…");
      try {
        const res = await apiRequest<{ ok: true; migrationTargetUrl: string }>(
          "/system/migration/start",
          { method: "POST", body: JSON.stringify({ serverId: opts.serverId, domain }) },
        );
        spin?.succeed("Migration complete.");
        report(res, () => ok(`\n  Now serving at ${res.migrationTargetUrl}\n`));
      } catch (e) {
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
        const res = await apiRequest<{ ok: true; publicUrl: string; imported: unknown }>(
          "/system/migration/start-cloud",
          {
            method: "POST",
            body: JSON.stringify({ allowNonEmptyTarget: opts.allowNonEmptyTarget === true }),
          },
        );
        spin?.succeed("Cloud migration complete.");
        report(res, () => ok(`\n  Now hosted at ${res.publicUrl}\n`));
      } catch (e) {
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
        const res = await apiRequest<{ ok: true; migrationTargetUrl: string }>(
          "/system/migration/start-tunnel",
          { method: "POST", body: JSON.stringify({ slug: opts.slug }) },
        );
        spin?.succeed("Tunnel active.");
        report(res, () => ok(`\n  Now reachable at ${res.migrationTargetUrl}\n`));
      } catch (e) {
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
        process.exit(1);
      }
      const spin = spinner("Switching back…");
      try {
        const res = await apiRequest<{
          ok: true;
          previousMode: string;
          rowsRestored: number;
          syncedFromRemote: boolean;
        }>("/system/migration/switch-back", {
          method: "POST",
          body: JSON.stringify({ abandonRemote: opts.abandonRemote === true }),
        });
        spin?.succeed("Switched back to single-user.");
        report(res, () =>
          ok(
            `\n  Reversed ${res.previousMode}. ` +
              (res.syncedFromRemote ? `${res.rowsRestored} rows restored.` : "Kept local data.") +
              "\n",
          ),
        );
      } catch (e) {
        spin?.fail("Switch-back failed.");
        throw e;
      }
    });
  });

/* ── data-transfer export / import ───────────────────────────────────
 * POST /api/system/data-transfer/{export,import} → data-transfer.controller
 * (owner-only). Moves the WHOLE instance database; secrets are sealed with an
 * optional passphrase. Import defaults to wipe mode.
 */
const dataTransferCommand = new Command("data-transfer").description(
  "Whole-instance export / import (owner-only)",
);

dataTransferCommand
  .command("export")
  .description("Export the entire instance to a JSON file")
  .option("--passphrase <passphrase>", "Seal secrets under this passphrase")
  .option("--out <file>", "Write the export to this file instead of stdout")
  .action(async (opts) => {
    await guarded(async () => {
      const spin = spinner("Exporting instance…");
      try {
        const file = await apiRequest<{ dump: { tables: Record<string, unknown> } }>(
          "/system/data-transfer/export",
          {
            method: "POST",
            body: JSON.stringify(opts.passphrase ? { passphrase: opts.passphrase } : {}),
          },
        );
        spin?.succeed("Export ready.");
        if (opts.out) {
          writeFileSync(opts.out, JSON.stringify(file));
          const tables = Object.keys(file.dump?.tables ?? {}).length;
          report({ out: opts.out, tables }, () =>
            ok(`\n  Wrote ${tables} tables to ${opts.out}\n`),
          );
        } else {
          printJson(file);
        }
      } catch (e) {
        spin?.fail("Export failed.");
        throw e;
      }
    });
  });

dataTransferCommand
  .command("import")
  .description("Import an instance export file")
  .requiredOption("--file <path>", "Path to an export file")
  .option("--passphrase <passphrase>", "Passphrase used at export time")
  .option("--mode <mode>", "wipe (replace) | merge", "wipe")
  .option("-y, --yes", "Skip the confirmation prompt")
  .action(async (opts) => {
    await guarded(async () => {
      const mode = opts.mode === "merge" ? "merge" : "wipe";
      if (mode === "wipe" && !(await confirm("Wipe this instance and import the file?", opts.yes))) {
        err("\n  Aborted.\n");
        process.exit(1);
      }

      let file: unknown;
      try {
        file = JSON.parse(readFileSync(opts.file, "utf8"));
      } catch {
        err(`\n  Could not read or parse ${opts.file}.\n`);
        process.exit(1);
      }

      const spin = spinner("Importing instance…");
      try {
        const res = await apiRequest<{
          mode: string;
          rowsRestored: number;
          secretsRehydrated: number;
          secretsSkipped: boolean;
          localPathProjects?: Array<{ slug: string; localPath: string }>;
        }>("/system/data-transfer/import", {
          method: "POST",
          body: JSON.stringify({ file, passphrase: opts.passphrase, mode }),
        });
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
