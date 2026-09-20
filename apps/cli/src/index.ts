import { Command, CommanderError } from "commander";
import { err, setJsonMode } from "./lib/output";
import { initializeNativeClient } from "./lib/native-client";
import { closeNativeClient, cliUserAgent } from "./lib/ship-client";
import { CommandExit } from "./lib/command-exit";

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

// Self-host infrastructure
import { serverCommand } from "./commands/server";
import { systemCommand } from "./commands/system";
import { mailCommand } from "./commands/mail";
import { backupCommand } from "./commands/backup";

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
import { serviceStatus } from "./lib/service";
import { readInstallMethod } from "./lib/compose";

//completion
import { attachCompletion } from "./commands/completion";

// Injected at build time by tsup (define). Always present in the built binary.
declare const __CLI_VERSION__: string;

const program = new Command();

program
  .name("openship")
  .description("Openship CLI — install, run, and manage Openship from your terminal")
  .version(__CLI_VERSION__)
  .exitOverride()
  .option("--json", "Machine-readable JSON output (stdout data only)")
  .option("--native-config <file>", "Run SDK commands using an explicitly trusted JavaScript configuration")
  .hook("preAction", async (thisCommand, actionCommand) => {
    if (thisCommand.opts().json) setJsonMode(true);
    const file = thisCommand.opts().nativeConfig as string | undefined;
    if (file) {
      let top = actionCommand;
      while (top.parent && top.parent !== thisCommand) top = top.parent;
      if (!["project", "app", "service", "domain", "deploy", "deployment", "logs", "init", "server", "system", "backup", "status", "doctor"].includes(top.name()))
        throw new Error("Choose an SDK resource command with --native-config; installation and remote-login commands use a remote context.");
      await initializeNativeClient(file, cliUserAgent);
    }
  })
  // Bare `openship` (no subcommand): setup wizard on a fresh box, or the control
  // panel once a service is already installed (manage instead of starting over).
  .action(async () => {
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
    else await runWizard();
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

// Self-host infrastructure (secondary)
program.addCommand(serverCommand);
program.addCommand(systemCommand);
program.addCommand(mailCommand);
program.addCommand(backupCommand);

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
    await program.parseAsync();
  } catch (error) {
    if (interrupted) return;
    if (error instanceof CommandExit) process.exitCode = error.code;
    else if (error instanceof CommanderError) process.exitCode = error.exitCode;
    else { err(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
  } finally {
    try { await closeNativeClient(); }
    catch (error) { err(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
    if (native) { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate); }
  }
}

void main();
