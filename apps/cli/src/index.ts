import { errorReporter } from "@repo/core/diagnostics";
import { installNodeErrorReporting, withErrorContext } from "@repo/core/diagnostics/node";
import { Command, CommanderError, Option } from "commander";
import { err, isJsonMode, setJsonMode } from "./lib/output";
import { initializeNativeClient } from "./lib/native-client";
import { closeNativeClient, cliUserAgent, setCommandOrganization } from "./lib/ship-client";
import { CommandExit } from "./lib/command-exit";
import { enableLocalCommandAuthentication, closeCommandConnection, selectCommandConnection, withCommandContext } from "./lib/config";

// Auth & session
import { loginCommand } from "./commands/login";
import { logoutCommand } from "./commands/logout";
import { openCommand } from "./commands/open";

// Run & workspace
import { upCommand } from "./commands/up";
import { stopCommand } from "./commands/stop";
import { uninstallCommand } from "./commands/uninstall";
import { initCommand } from "./commands/init";
import { configCommand } from "./commands/config";
import { contextCommand } from "./commands/context";
import { statusCommand } from "./commands/status";
import { doctorCommand } from "./commands/doctor";

// Deploy loop
import { deployCommand } from "./commands/deploy";
import { deploymentCommand } from "./commands/deployment";
import { logsCommand } from "./commands/logs";

// Resources
import { projectCommand } from "./commands/project";
import { appCommand } from "./commands/app";
import { serviceCommand } from "./commands/service";
import { domainCommand } from "./commands/domain";
import { edgeCommand } from "./commands/edge";
import { monitoringCommand } from "./commands/monitoring";
import { credentialCommand } from "./commands/credential";
import { dnsCommand } from "./commands/dns";
import { notificationCommand } from "./commands/notification";
import { webhookCommand } from "./commands/webhook";
import { auditCommand } from "./commands/audit";
import { accessCommand } from "./commands/access";
import { billingCommand } from "./commands/billing";
import { githubCommand } from "./commands/github";
import { settingsCommand } from "./commands/settings";
import { analyticsCommand } from "./commands/analytics";
import { migrationCommand } from "./commands/migration";

// Self-host infrastructure
import { serverCommand } from "./commands/server";
import { systemCommand } from "./commands/system";
import { mailCommand } from "./commands/mail";
import { backupCommand } from "./commands/backup";
import { jobCommand } from "./commands/job";

// Access & escape hatch
import { tokenCommand } from "./commands/token";
import { apiCommand } from "./commands/api";
import { resetAdminCommand } from "./commands/reset-admin";

// Distribution
import { installCommand } from "./commands/install";
import { updateCommand } from "./commands/update";
import { cacheCommand } from "./commands/cache";

// Interactive setup / control (bare `openship`)
import { runWizard, runControl, isSetupInProgress } from "./commands/wizard";
import { runWelcome } from "./commands/welcome";
import { serviceStatus } from "./lib/service";
import { readInstallMethod } from "./lib/compose";

//completion
import { attachCompletion } from "./commands/completion";

// Injected at build time by tsup (define). Always present in the built binary.
declare const __CLI_VERSION__: string;

const program = new Command();
installNodeErrorReporting("cli");
const sdkCommands = new Set([
  projectCommand, appCommand, serviceCommand, domainCommand, deployCommand,
  deploymentCommand, logsCommand, initCommand, serverCommand, systemCommand,
  backupCommand, jobCommand, statusCommand, doctorCommand, monitoringCommand,
  credentialCommand, dnsCommand, notificationCommand, webhookCommand, auditCommand, accessCommand, tokenCommand,
  billingCommand, githubCommand, settingsCommand, analyticsCommand,
]);
const remoteCommands = new Set([...sdkCommands, apiCommand, edgeCommand, mailCommand, migrationCommand, openCommand, logoutCommand]);

program
  .name("openship")
  .description("Openship CLI — install, run, and manage Openship from your terminal")
  .version(__CLI_VERSION__)
  .exitOverride()
  .enablePositionalOptions()
  .option("--json", "Machine-readable JSON output (stdout data only)")
  .addOption(new Option("--context <name>", "Use a saved connection for this command without changing the default").conflicts(["apiUrl", "nativeConfig", "local"]))
  .addOption(new Option("--api-url <url>", "Use a remote API for this command; authenticate with OPENSHIP_TOKEN").conflicts(["context", "nativeConfig", "local"]))
  .addOption(new Option("--local", "Use this machine's installation with its private administrator credential").conflicts(["context", "apiUrl", "nativeConfig"]))
  .option("--organization <id>", "Use a fixed organization scope for SDK resource commands (remote only)")
  .option("--native-config <file>", "Run SDK commands using an explicitly trusted JavaScript configuration")
  .hook("preAction", async (thisCommand, actionCommand) => {
    if (thisCommand.opts().json) setJsonMode(true);
    let top = actionCommand;
    while (top.parent && top.parent !== thisCommand) top = top.parent;
    const file = thisCommand.opts().nativeConfig as string | undefined;
    const organization = thisCommand.opts().organization as string | undefined;
    if (organization !== undefined && (file || !remoteCommands.has(top)))
      throw new Error("Use --organization with remote SDK resource commands. Native organization selection belongs in --native-config.");
    const context = thisCommand.opts().context as string | undefined;
    const apiUrl = thisCommand.opts().apiUrl as string | undefined;
    const local = thisCommand.opts().local as boolean | undefined;
    if ((context !== undefined || apiUrl !== undefined) && !remoteCommands.has(top) && top !== loginCommand)
      throw new Error("Use connection options with a remote resource command. Installation commands manage this machine.");
    if (local && (!remoteCommands.has(top) || top === logoutCommand))
      throw new Error("Use --local with a resource command. Local setup and recovery commands already manage this machine.");
    const connection = !file && remoteCommands.has(top) ? selectCommandConnection({ context, apiUrl, local }) : undefined;
    setCommandOrganization(organization ?? connection?.organizationId);
    // Help/schema and connection management must remain usable offline. Health
    // and dashboard opening need the local endpoint, but no admin session.
    if (connection && !actionCommand.opts().schema && top !== logoutCommand && top !== openCommand && top !== statusCommand && top !== doctorCommand)
      enableLocalCommandAuthentication();
    if (file) {
      if (!sdkCommands.has(top))
        throw new Error("Choose an SDK resource command with --native-config; installation and remote-login commands use a remote context.");
      await initializeNativeClient(file, cliUserAgent);
    }
  })
  // Bare `openship` (no subcommand): setup wizard on a fresh box, or the control
  // panel once a service is already installed (manage instead of starting over).
  .action(async () => {
    if (process.stdin.isTTY !== true || isJsonMode()) {
      throw new Error("Choose a command for non-interactive use. Run openship --help to see the available commands.");
    }
    // A service is installed AND setup finished → manage it. If a prior setup
    // was interrupted (service installed but never completed), resume the wizard
    // instead of showing the control panel as if the install were done.
    //
    // "installed" must cover a Docker Compose install too: that path installs NO
    // systemd/launchd unit (the stack restarts via Docker's own policy), so
    // serviceStatus().installed is false for it. Without the readInstallMethod
    // check, re-running `openship` after a finished compose install (the Linux
    // default) drops back into the full setup wizard instead of the control panel.
    const installed = serviceStatus().installed || readInstallMethod() === "compose";
    if (installed && !isSetupInProgress()) await runControl();
    else if (isSetupInProgress()) await runWizard();
    else await runWelcome(runWizard, () => program.outputHelp());
  });

// Run the platform / auth / workspace
program.addCommand(upCommand);
program.addCommand(stopCommand);
program.addCommand(uninstallCommand);
program.addCommand(installCommand);
program.addCommand(updateCommand);
program.addCommand(openCommand);
program.addCommand(loginCommand);
program.addCommand(logoutCommand);
program.addCommand(initCommand);
program.addCommand(configCommand);
program.addCommand(contextCommand);
program.addCommand(statusCommand);
program.addCommand(doctorCommand);

// Deploy loop
program.addCommand(deployCommand);
program.addCommand(deploymentCommand);
program.addCommand(logsCommand);

// Resources
program.addCommand(projectCommand);
program.addCommand(appCommand);
program.addCommand(serviceCommand);
program.addCommand(domainCommand);
program.addCommand(edgeCommand);
program.addCommand(monitoringCommand);
program.addCommand(credentialCommand);
program.addCommand(dnsCommand);
program.addCommand(notificationCommand);
program.addCommand(webhookCommand);
program.addCommand(auditCommand);
program.addCommand(accessCommand);
program.addCommand(billingCommand);
program.addCommand(githubCommand);
program.addCommand(settingsCommand);
program.addCommand(analyticsCommand);
program.addCommand(migrationCommand);

// Self-host infrastructure (secondary)
program.addCommand(serverCommand);
program.addCommand(systemCommand);
program.addCommand(mailCommand);
program.addCommand(backupCommand);
program.addCommand(jobCommand);

// Access + escape hatch
program.addCommand(tokenCommand);
program.addCommand(apiCommand);
program.addCommand(resetAdminCommand);

// `cache` is a maintenance concern of `install`, not a top-level verb.
installCommand.addCommand(cacheCommand);

// for autocomplete
attachCompletion(program);

async function main() {
  let interrupted = false;
  const onSignal = (signal: "SIGINT" | "SIGTERM") => {
    interrupted = true;
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    void closeNativeClient().catch(error => err(error instanceof Error ? error.message : String(error)));
  };
  const interrupt = () => onSignal("SIGINT");
  const terminate = () => onSignal("SIGTERM");
  // Only an explicit native invocation owns a worker to drain. Other commands
  // keep their existing OS/service signal behavior.
  const native = process.argv.some(arg => arg === "--native-config" || arg.startsWith("--native-config="));
  if (native) { process.on("SIGINT", interrupt); process.on("SIGTERM", terminate); }
  try {
    await withCommandContext(async () => {
      try { await program.parseAsync(); }
      finally { await closeCommandConnection(); }
    });
  } catch (error) {
    if (interrupted) return;
    if (error instanceof CommandExit) process.exitCode = error.code;
    else if (error instanceof CommanderError) process.exitCode = error.exitCode;
    else { err(error instanceof Error ? error.message : String(error), error); process.exitCode = 1; }
  } finally {
    try { await closeNativeClient(); }
    catch (error) { err(error instanceof Error ? error.message : String(error), error); process.exitCode = 1; }
    if (native) { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate); }
    await errorReporter.flush(500);
  }
}

void withErrorContext({ source: "cli", kind: "operation", component: "cli" }, main, true);
