import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { Command } from "commander";
import chalk from "chalk";
import { CLOUD_DASHBOARD_URL, LOCAL_API_URL } from "@repo/core";
import { waitForApi } from "@repo/onboarding";
import { getApiUrl, getDashboardUrl } from "../lib/config";

export const openCommand = new Command("open")
  .description("Open the Openship dashboard in your browser")
  .option("--cloud", "Open the hosted cloud dashboard (app.openship.io)")
  .option("--dashboard-url <url>", "Dashboard base URL to open")
  .option("--context <name>", "Context whose dashboard URL to open")
  .option("--path <path>", "Path to open on the dashboard (e.g. /settings)")
  .action(async (opts) => {
    const base: string = opts.cloud
      ? CLOUD_DASHBOARD_URL
      : opts.dashboardUrl || getDashboardUrl(opts.context);
    const target = opts.path ? new URL(opts.path, base).toString() : base;

    // For a local dashboard, warn (don't block) if the API isn't up yet, so we
    // don't silently open a dead page. Cloud is assumed reachable.
    if (/localhost|127\.0\.0\.1/.test(base)) {
      const apiUrl = getApiUrl(opts.context) || LOCAL_API_URL;
      const ready = await waitForApi({ apiUrl }, 3, 1000);
      if (!ready) {
        console.log(
          chalk.yellow(`\n  Heads up: the local API at ${apiUrl} isn't responding yet.`) +
            chalk.dim("\n  Start it with `openship up`, or use --cloud.\n"),
        );
      }
    }

    try {
      const { default: open } = await import("open");
      await open(target);
      console.log(chalk.dim(`\n  Opening ${target}\n`));
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "cli/commands/open");
      console.log(chalk.dim("\n  Couldn't open a browser. Visit:\n") + chalk.cyan(`  ${target}\n`));
    }
  });
