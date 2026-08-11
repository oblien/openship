/**
 * `openship uninstall` — remove Openship from this machine.
 *
 * The counterpart to `openship up`. Where `stop` just halts things (compose down /
 * unload the service, keeping data), uninstall is the DESTRUCTIVE version: it also
 * drops the stack's volumes (database, issued certificates, edge vhosts), deletes
 * the images we own, and removes ~/.openship.
 *
 * Two things it deliberately does NOT do, because this box is usually shared with
 * the operator's own workloads:
 *   • never prunes images/volumes broadly — only our three images, by exact tag,
 *     and only this project's volumes via `down -v`.
 *   • never deletes DEPLOYED app containers/volumes. Those are the user's
 *     workloads; removing the control plane shouldn't take their apps down with it
 *     (that's what project deletion is for).
 *
 * It also tries to hand :80/:443 back: if an install took over a proxy and never
 * finished, the takeover journal is rolled back so the previous proxy returns.
 */
import { Command } from "commander";
import chalk from "chalk";
import { confirm, isCancel } from "@clack/prompts";
import { existsSync, rmSync } from "node:fs";

import { stop as stopService } from "../lib/service";
import { readInstallMethod, composeUninstall } from "../lib/compose";
import { rollbackHostEdge } from "../lib/edge-preflight";
import { OS_DIR } from "../lib/paths";

export const uninstallCommand = new Command("uninstall")
  .description(
    "Remove Openship from this machine: stop it, delete its data (database, certs, edge config), its images, and ~/.openship. Deployed apps are left running.",
  )
  .option("-y, --yes", "Skip the confirmation prompt (for scripts)")
  .option("--keep-data", "Keep the database/certs volumes and ~/.openship — remove only the running stack")
  .option("--keep-images", "Don't delete the Openship container images")
  .action(async (opts: { yes?: boolean; keepData?: boolean; keepImages?: boolean }) => {
    const method = readInstallMethod();
    const destructive = !opts.keepData;

    if (!opts.yes) {
      const lines = [
        method === "compose"
          ? "  • stop the Docker Compose stack (api, dashboard, postgres, redis, edge)"
          : "  • stop and remove the Openship service",
        destructive ? "  • DELETE its data: database, issued certificates, edge vhosts" : null,
        destructive ? `  • DELETE ${OS_DIR} (config, tokens, local database)` : null,
        !opts.keepImages && method === "compose" ? "  • delete the Openship container images" : null,
        "  • leave your DEPLOYED apps and their data untouched",
      ].filter(Boolean);
      console.log(chalk.yellow("\n  This will:\n") + lines.join("\n") + "\n");
      const go = await confirm({
        message: destructive ? "Permanently remove Openship and its data?" : "Remove Openship (keeping data)?",
        initialValue: false,
      });
      if (isCancel(go) || !go) {
        console.log(chalk.dim("\n  Cancelled — nothing was changed.\n"));
        return;
      }
    }

    // Before tearing the edge down: if an install stopped the operator's proxy and
    // never completed, put it back. Best-effort and a no-op when there's no
    // unfinished journal (a COMPLETED takeover cleared it — see the hint below).
    const restored = await rollbackHostEdge().catch(() => false);
    if (restored) console.log(chalk.green("  Restored the proxy that was running before Openship."));

    if (method === "compose") {
      const { ok, removedImages } = composeUninstall({ removeImages: !opts.keepImages });
      if (!ok) {
        console.log(
          chalk.yellow("  No compose stack found (or `down` failed) — continuing with local cleanup."),
        );
      } else {
        console.log(
          chalk.green(`  Stack removed${destructive ? " (including its volumes)" : ""}.`),
        );
      }
      for (const ref of removedImages) console.log(chalk.dim(`  removed image ${ref}`));
    } else {
      try {
        const res = stopService();
        console.log(chalk.green(`  Service removed — ${res.detail}`));
      } catch (err) {
        console.log(chalk.yellow(`  Couldn't remove the service: ${(err as Error).message}`));
      }
    }

    if (destructive && existsSync(OS_DIR)) {
      try {
        rmSync(OS_DIR, { recursive: true, force: true });
        console.log(chalk.green(`  Removed ${OS_DIR}`));
      } catch (err) {
        console.log(chalk.yellow(`  Couldn't remove ${OS_DIR}: ${(err as Error).message}`));
      }
    }

    console.log(
      chalk.green("\n  ✔ Openship uninstalled.\n") +
        // A takeover that SUCCEEDED cleared its journal, so we have no record of
        // what to restart — say so rather than leaving :80/:443 quietly dark.
        (restored
          ? ""
          : chalk.dim(
              "  If Openship took over :80/:443 from another proxy, re-enable it:\n" +
                "    sudo systemctl enable --now nginx   (or caddy / apache2)\n",
            )) +
        chalk.dim("  Deployed apps are still running — `docker ps` to review them.\n"),
    );
  });
