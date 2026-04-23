/**
 * Dev script — watches source files and auto-restarts Electron.
 *
 *  1. `tsc --watch` recompiles main + preload on change
 *  2. `electronmon .` auto-restarts when out/ changes
 */

import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// 1. TypeScript watch for main + preload
const tsc = spawn("npx", ["tsc", "--watch", "--preserveWatchOutput"], {
  cwd: root,
  stdio: "inherit",
});

// 2. Start electronmon (auto-restarts on out/ changes)
// Small delay to let initial tsc --watch settle
setTimeout(() => {
  const em = spawn("npx", ["electronmon", "."], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      // Default to the public cloud control plane.
      // Override these vars when testing against a local SaaS dev instance.
      OPENSHIP_CLOUD_URL: process.env.OPENSHIP_CLOUD_URL || "https://api.openship.io",
      OPENSHIP_CLOUD_DASHBOARD_URL: process.env.OPENSHIP_CLOUD_DASHBOARD_URL || "https://app.openship.io",
    },
  });

  em.on("close", (code) => {
    tsc.kill();
    process.exit(code ?? 0);
  });
}, 2000);

process.on("SIGINT", () => {
  tsc.kill();
  process.exit(0);
});
