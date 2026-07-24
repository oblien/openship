import { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { LOCAL_API_URL, LOCAL_DASHBOARD_URL } from "@repo/core";
import { addContext, DEFAULT_CONTEXT, getContext, setActiveContext } from "../lib/config";
import { fetchCaps } from "../lib/caps";

export const loginCommand = new Command("login")
  .description("Authenticate with a Personal Access Token (create one in dashboard Settings)")
  .option("--token <token>", "Personal Access Token (opsh_pat_...) for non-interactive login")
  .option("--api-url <url>", "API base URL (default: the context's saved URL, else http://localhost:4000)")
  .option("--dashboard-url <url>", "Dashboard base URL (default: the context's saved URL, else http://localhost:3000)")
  .option("--context <name>", "Name of the context to store this login under", DEFAULT_CONTEXT)
  .action(async (opts) => {
    const contextName: string = opts.context || DEFAULT_CONTEXT;
    // Re-authing an existing context must NOT reset its endpoints. Only override
    // when the flag is explicitly passed; otherwise keep the saved URL (falling
    // back to localhost for a brand-new context).
    const existing = getContext(contextName);
    const apiUrl: string = opts.apiUrl || existing.apiUrl || LOCAL_API_URL;
    const dashboardUrl: string = opts.dashboardUrl || existing.dashboardUrl || LOCAL_DASHBOARD_URL;

    let token: string | undefined = opts.token;

    // Interactive: open the PAT settings page and read a pasted token.
    if (!token) {
      const settingsUrl = `${dashboardUrl}/settings`;
      console.log(
        chalk.bold("\n  Openship login\n") +
          chalk.dim("  Create a Personal Access Token in Settings → Personal Access Tokens,\n") +
          chalk.dim("  then paste it here.\n"),
      );
      try {
        const { default: open } = await import("open");
        await open(settingsUrl);
      } catch {
        // Browser open is best-effort; the URL is printed below regardless.
      }
      console.log(
        chalk.dim("  If the browser didn't open, visit:\n") + chalk.cyan(`  ${settingsUrl}\n`),
      );

      const rl = createInterface({ input, output });
      token = await rl.question("  Paste your token: ");
      rl.close();
    }

    token = token?.trim();
    if (!token) {
      console.error(chalk.red("\n  No token provided.\n"));
      process.exit(1);
    }
    if (!token.startsWith("opsh_pat_")) {
      console.error(
        chalk.red("\n  That doesn't look like an Openship token (expected opsh_pat_…).\n"),
      );
      process.exit(1);
    }

    // Validate the token against an authenticated endpoint before storing.
    // 200 → valid; 403 → valid but lacks settings:read scope (still usable).
    let valid = false;
    let scoped = false;
    try {
      const res = await fetch(`${apiUrl}/api/tokens`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) valid = true;
      else if (res.status === 403) {
        valid = true;
        scoped = true;
      }
    } catch {
      console.error(
        chalk.red(`\n  Couldn't reach the API at ${apiUrl}. `) +
          chalk.dim("Is it running? Use --api-url for a different host.\n"),
      );
      process.exit(1);
    }

    if (!valid) {
      console.error(
        chalk.red("\n  Token rejected by the API. Check that it's valid and not revoked.\n"),
      );
      process.exit(1);
    }

    addContext(contextName, { apiUrl, dashboardUrl, token });
    setActiveContext(contextName);

    // Best-effort capability discovery so later commands can gate offline.
    await fetchCaps({ force: true }).catch(() => undefined);

    console.log(
      chalk.green(`\n  Logged in`) +
        chalk.dim(` (context "${contextName}"). Token saved to ~/.openship/config.json\n`),
    );
    if (scoped) {
      console.log(
        chalk.dim("  (Token lacks settings:read scope — some commands may be limited.)\n"),
      );
    }
  });
