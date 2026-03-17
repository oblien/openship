/**
 * Dev script — watches source files and auto-restarts Electron.
 *
 *  1. `tsc --watch` recompiles main + preload on change
 *  2. fs.watch copies renderer files on change
 *  3. `electronmon .` auto-restarts when out/ changes
 */

import { spawn } from "node:child_process";
import { watch, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src", "renderer");
// out/ is already clean — `npm run build` (rm -rf out && tsc && cp renderer)
// runs before this script, so we just start watchers.
const dest = join(root, "out", "renderer");

// 1. TypeScript watch for main + preload
const tsc = spawn("npx", ["tsc", "--watch", "--preserveWatchOutput"], {
  cwd: root,
  stdio: "inherit",
});

// 2. Watch renderer files and copy on change
function syncRenderer() {
  cpSync(src, dest, { recursive: true });
}

watch(src, { recursive: true }, () => {
  syncRenderer();
});

// 3. Start electronmon (auto-restarts on out/ changes)
// Small delay to let initial tsc --watch settle
setTimeout(() => {
  const em = spawn("npx", ["electronmon", "."], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      // Point to local SaaS dev instance (pnpm dev:saas) for cloud auth testing
      OPENSHIP_CLOUD_URL: process.env.OPENSHIP_CLOUD_URL || "http://localhost:4100",
      OPENSHIP_CLOUD_DASHBOARD_URL: process.env.OPENSHIP_CLOUD_DASHBOARD_URL || "http://localhost:3002",
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
