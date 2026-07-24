/**
 * `openship update` — update the globally-installed CLI (which bundles the
 * self-hosted API server) to the latest published release.
 *
 * Talks to GitHub (releases/latest), NOT the Openship API. The version gate +
 * install-command are pure functions in @repo/core (`resolveCliUpdatePlan` /
 * `cliInstallCommand`), unit-tested there. This command just detects the
 * package manager and re-installs the global package, then tells the operator
 * to restart `openship up`.
 *
 *   openship update            update if a newer release exists
 *   openship update --check    report current/latest only (no install)
 *   openship update --via npm  force the package manager (default: bun if present, else npm)
 */
import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { resolveCliUpdatePlan, cliInstallCommand, type CliPackageManager } from "@repo/core";
import { resolveLatestTag } from "../lib/github-releases";
import { restart as restartService } from "../lib/service";
import { readInstallMethod, composeUpdate } from "../lib/compose";
import { err, info, isJsonMode, ok, printJson } from "../lib/output";

declare const __CLI_VERSION__: string;

/** Prefer bun (the curl installer uses `bun add -g`); fall back to npm. */
function detectPackageManager(override?: string): CliPackageManager {
  if (override === "bun" || override === "npm") return override;
  const hasBun = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;
  return hasBun ? "bun" : "npm";
}

export const updateCommand = new Command("update")
  .description("Update the Openship CLI + bundled server to the latest release")
  .option("--check", "Only report the current + latest version; don't install")
  .option("--via <manager>", "Package manager to update with: bun | npm")
  .action(async (opts) => {
    const current = __CLI_VERSION__;

    let latest: string;
    try {
      latest = (await resolveLatestTag()).replace(/^v/, "");
    } catch {
      err("Could not reach GitHub to check for updates. Try again, or reinstall manually.");
      process.exitCode = 1;
      return;
    }

    const plan = resolveCliUpdatePlan(current, latest);

    if (opts.check) {
      if (isJsonMode()) {
        printJson({ current, latest, updateAvailable: plan.action === "install" });
      } else if (plan.action === "install") {
        info(`Update available: v${current} → v${latest}. Run \`openship update\`.`);
      } else {
        ok(`Up to date (v${current}).`);
      }
      return;
    }

    if (plan.action === "up-to-date") {
      ok(`Already on the latest version (v${current}).`);
      return;
    }

    const pm = detectPackageManager(opts.via);
    const ref = `openship@${latest}`;
    const argv = pm === "bun" ? ["add", "-g", ref] : ["install", "-g", ref];

    info(`Updating v${current} → v${latest} (${cliInstallCommand(pm, latest)})...`);
    const res = spawnSync(pm, argv, { stdio: "inherit", shell: process.platform === "win32" });
    if (res.status !== 0) {
      err(`Update failed (${pm} exited ${res.status ?? "with a signal"}). Reinstall manually: ${cliInstallCommand(pm, latest)}`);
      process.exitCode = 1;
      return;
    }

    // Compose install → pull the new-version images + recreate the stack (the
    // CLI package update above refreshed the compose template/pin). Bare install
    // → restart the process service so it picks up the new bundle.
    if (readInstallMethod() === "compose") {
      const pulled = composeUpdate(latest);
      if (isJsonMode()) {
        printJson({ updated: true, from: current, to: latest, via: pm, method: "compose", pulled });
      } else if (pulled) {
        ok(`Updated to v${latest} and pulled the new images — the compose stack is on the new version.`);
      } else {
        err(`Updated the CLI to v${latest}, but \`docker compose pull\` failed. Run \`openship up\` to retry.`);
        process.exitCode = 1;
      }
      return;
    }

    // Redeploy: restart the installed service so it picks up the new bundle.
    // No service installed (e.g. `openship up --foreground`) → tell them to
    // relaunch. The service manager (KeepAlive / Restart=always) handles the
    // brief blip while the new version boots.
    const { restarted } = restartService();

    if (isJsonMode()) {
      printJson({ updated: true, from: current, to: latest, via: pm, restarted });
    } else if (restarted) {
      ok(`Updated to v${latest} and restarted the service — you're on the new version.`);
    } else {
      ok(`Updated to v${latest}. Restart the server to run the new version: openship up`);
    }
  });
