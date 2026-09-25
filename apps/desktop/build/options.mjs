import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// Both development and packaged preloads are bundled. A sandboxed renderer can
// require Electron, but must never depend on Node's module loader for helpers.
export const desktopBuildOptions = ["main", "preload"].map(entry => ({
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["electron"],
  logLevel: "info",
  entryPoints: [join(desktopRoot, `src/${entry}/index.ts`)],
  outfile: join(desktopRoot, `dist/${entry}/index.js`),
}));
