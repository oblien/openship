/**
 * `openship reset-admin-password` — recover the box login WITHOUT signing in.
 *
 * The CLI owns the loopback internal token (~/.openship/internal-token) that the
 * running service loaded at boot, so it can hit the internal-token-gated
 * /api/system/reset-admin-password on localhost — "god access" from the machine
 * itself. This is the forgot-password path for a self-hosted box: reset the local
 * admin credential (and force authMode back to local, so it also un-sticks a box
 * that got locked onto a broken cloud login).
 */
import { Command } from "commander";
import chalk from "chalk";
import { intro, outro, password as passwordPrompt, isCancel, cancel, log } from "@clack/prompts";
import { storedApiPort } from "../lib/ports";
import { ensureInternalToken } from "./up";

export const resetAdminCommand = new Command("reset-admin-password")
  .description("Reset the local admin login on THIS machine (no sign-in required)")
  .option("--port <port>", "API port of the running service (default: the port this install resolved to, else 4000)")
  .option("--email <email>", "Also set the admin email")
  .option("--name <name>", "Also set the admin display name")
  .option("--password <password>", "New password (prompted if omitted)")
  .action(async (opts) => {
    intro(chalk.cyan("Reset Openship admin password"));

    let pw: string | undefined = opts.password;
    if (!pw) {
      if (!process.stdin.isTTY) {
        log.error("--password is required in non-interactive mode.");
        process.exit(1);
      }
      const entered = await passwordPrompt({
        message: "New admin password",
        validate: (v) => (v && v.length >= 8 && v.length <= 128 ? undefined : "8–128 characters"),
      });
      if (isCancel(entered)) {
        cancel("Cancelled.");
        process.exit(0);
      }
      const confirm = await passwordPrompt({
        message: "Confirm password",
        validate: (v) => (v === entered ? undefined : "Passwords don't match"),
      });
      if (isCancel(confirm)) {
        cancel("Cancelled.");
        process.exit(0);
      }
      pw = entered;
    }

    // Ports are dynamic; storedApiPort() is the remembered one (4000 only as the
    // last-resort default), so the reset targets whichever port this box resolved to.
    const port = String(opts.port || storedApiPort());
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${port}/api/system/reset-admin-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Token": ensureInternalToken() },
        body: JSON.stringify({ password: pw, email: opts.email, name: opts.name }),
      });
    } catch {
      log.error(`Couldn't reach the Openship API on port ${port}. Is it running? (openship status)`);
      log.info("If it's listening on another port, pass --port <n>.");
      process.exit(1);
    }

    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; email?: string; error?: string };
    if (!res.ok || !data.ok) {
      log.error(`Reset failed: ${data.error || res.statusText}`);
      process.exit(1);
    }
    outro(chalk.green(`Password reset. Log in as ${data.email} with your new password.`));
  });
