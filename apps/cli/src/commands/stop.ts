import { Command } from "commander";
import chalk from "chalk";
import { stop } from "../lib/service";
import { readInstallMethod, composeDown } from "../lib/compose";

export const stopCommand = new Command("stop")
  .description("Stop Openship (started by `openship up`) — it won't restart or return on reboot")
  .action(() => {
    // Compose install → tear down the stack; else stop the bare process service.
    if (readInstallMethod() === "compose") {
      const ok = composeDown();
      if (ok) console.log(chalk.green("\n  ✔ Openship stopped (docker compose down).\n"));
      else console.error(chalk.red("\n  docker compose down failed (or no stack found).\n"));
      process.exit(ok ? 0 : 1);
    }
    try {
      const res = stop();
      // No lock cleanup here: the server reclaims a dead-owner PGlite lock itself
      // on the next boot, so a later `openship up` isn't blocked by a stale lock.
      console.log(chalk.green("\n  ✔ Openship stopped.\n") + chalk.dim(`  ${res.detail}\n`));
    } catch (e) {
      console.error(chalk.red(`\n  Couldn't stop the service: ${(e as Error).message}\n`));
      process.exit(1);
    }
  });
