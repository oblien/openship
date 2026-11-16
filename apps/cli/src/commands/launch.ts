import { Command, Option } from "commander";
import { confirm, isCancel, log, note, outro } from "@clack/prompts";
import { parseDeploySource, deploySetupHref } from "@repo/core";
import { waitForApi } from "@repo/onboarding";
import { isJsonMode } from "../lib/output";
import { exitCommand } from "../lib/command-exit";
import { localConnectionEndpoints } from "../lib/local-connection";
import { readInstallMethod, composeStart } from "../lib/compose";
import { serviceStatus } from "../lib/service";
import { storedDashboardPort } from "../lib/ports";
import { isSetupInProgress, runWizard } from "./wizard";
import { startService } from "./up";
import { reportCaughtError } from "@repo/core/diagnostics";

async function ask(message: string) {
  const answer = await confirm({ message, initialValue: false });
  if (isCancel(answer) || !answer) exitCommand(0);
}

/**
 * The deploy button's local bootstrap. Installation is interactive; application
 * configuration stays in the existing app/repository wizard, including its
 * Compose, env, domains, billing and review gates. Never selects a CLI context.
 */
export const launchCommand = new Command("launch")
  .description("Set up this machine and open an app or repository's deployment wizard")
  .addOption(new Option("--app <id>", "Catalog app ID").conflicts("repo"))
  .addOption(new Option("--repo <url>", "Public GitHub repository URL").conflicts("app"))
  .option("--branch <name>", "Repository branch (defaults to the repository's default)")
  .action(async (opts) => {
    const source = parseDeploySource(opts);
    if (!process.stdin.isTTY || isJsonMode())
      throw new Error(
        "Run openship launch in an interactive terminal. It never installs or deploys unattended.",
      );

    const installed = readInstallMethod() === "compose" || serviceStatus().installed;
    if (!installed || isSetupInProgress()) {
      await ask("Set up OpenShip on this machine before configuring your app?");
      await runWizard();
    } else if (!(await waitForApi({ apiUrl: localConnectionEndpoints().apiUrl }, 1, 0))) {
      await ask("Start the existing OpenShip installation on this machine?");
      if (readInstallMethod() === "compose") {
        if (!composeStart())
          throw new Error("Could not start OpenShip. Run openship up to inspect the installation.");
      } else {
        await startService({});
      }
    }
    // Setup can move the ports or establish a public hostname. Re-read only
    // this installation; OPENSHIP_API_URL/TOKEN and saved Cloud contexts do not participate.
    const local = localConnectionEndpoints();
    if (!(await waitForApi({ apiUrl: local.apiUrl }, 5, 1000)))
      throw new Error("OpenShip is not ready. Run openship doctor, then retry this command.");
    const target = new URL(deploySetupHref(source, "server"), local.dashboardUrl);
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password)
      throw new Error(
        "The local installation has an invalid dashboard URL. Check its instance configuration.",
      );
    note(target.href, "Continue in your OpenShip dashboard");
    log.info(
      "Review the destination, environment, storage and domains, then choose Deploy. No app has been deployed yet.",
    );
    if (
      process.env.SSH_CONNECTION &&
      ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)
    ) {
      const port = storedDashboardPort();
      note(
        `ssh -L ${port}:127.0.0.1:${port} <user>@<server>\n\nThen open the link above on your computer.`,
        "Reach a private dashboard over SSH",
      );
    } else if (!process.env.SSH_CONNECTION) {
      await ask("Open the deployment setup in your browser?");
      try {
        const { default: open } = await import("open");
        await open(target.href);
      } catch (error) {
        reportCaughtError(error, "cli/commands/launch");
        log.info("Open the link above in your browser to continue.");
      }
    }
    outro("Your deployment settings are ready to review.");
  });
