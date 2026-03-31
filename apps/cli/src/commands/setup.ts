import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import {
  waitForApi,
  LOCAL_API_URL,
  LOCAL_DASHBOARD_URL,
} from "@repo/onboarding";

export const setupCommand = new Command("setup")
  .description("Launch the Openship setup wizard in your browser")
  .option("--api-url <url>", "API base URL", LOCAL_API_URL)
  .option("--dashboard-url <url>", "Dashboard base URL", LOCAL_DASHBOARD_URL)
  .action(async (opts) => {
    const apiUrl = opts.apiUrl || LOCAL_API_URL;
    const dashboardUrl = opts.dashboardUrl || LOCAL_DASHBOARD_URL;
    const onboardingUrl = `${dashboardUrl}/onboarding`;

    console.log(
      chalk.bold("\n  Openship Setup\n") +
      chalk.dim("  Opening the setup wizard in your browser…\n"),
    );

    // Open browser
    const { default: open } = await import("open");
    await open(onboardingUrl);

    console.log(
      chalk.dim(`  If the browser didn't open, visit:\n`) +
      chalk.cyan(`  ${onboardingUrl}\n`),
    );

    // Poll for completion
    const spinner = ora("Waiting for setup to complete…").start();

    const pollUrl = `${apiUrl}/api/system/onboarding`;
    const maxAttempts = 300; // ~5 min at 1s intervals

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const res = await fetch(pollUrl, {
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          const data = (await res.json()) as { configured: boolean };
          if (data.configured) {
            spinner.succeed("Setup complete!");
            console.log(
              chalk.green("\n  Openship is configured and ready.\n") +
              chalk.dim(`  API:       ${apiUrl}\n`) +
              chalk.dim(`  Dashboard: ${dashboardUrl}\n`),
            );
            return;
          }
        }
      } catch {
        // API not ready or network error — keep polling
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    spinner.fail("Setup timed out. Complete the wizard in your browser and run this command again.");
  });
