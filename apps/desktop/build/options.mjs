import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// Both development and packaged preloads are bundled. A sandboxed renderer can
// require Electron, but must never depend on Node's module loader for helpers.
const bundleOptions = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["electron"],
  loader: { ".css": "text", ".woff2": "dataurl" },
  logLevel: "info",
};

export const desktopBuildOptions = [
  {
    ...bundleOptions,
    entryPoints: [join(desktopRoot, "src/main/index.ts")],
    outfile: join(desktopRoot, "dist/main/index.js"),
  },
  {
    ...bundleOptions,
    entryPoints: [join(desktopRoot, "src/preload/index.ts")],
    outfile: join(desktopRoot, "dist/preload/index.js"),
  },
  {
    ...bundleOptions,
    entryPoints: [join(desktopRoot, "src/preload/selfhost-prompt.ts")],
    outfile: join(desktopRoot, "dist/selfhost-prompt/index.js"),
  },
];
