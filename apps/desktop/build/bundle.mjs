/**
 * Bundle the Electron main + preload into self-contained CJS files.
 *
 * This is what makes the packaged app need ZERO runtime node_modules: the two
 * workspace deps (@repo/core, @repo/onboarding) are inlined, so forge can ship
 * just `out/` + package.json and skip dependency pruning entirely (which
 * flora-colossus can't do against bun's store-based node_modules anyway).
 *
 * Development uses these same options so sandbox behavior matches packaging.
 */

import { build } from "esbuild";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { desktopRoot, desktopBuildOptions } from "./options.mjs";

// Output to dist/, NOT out/ — `out/` is electron-forge's own output dir
// (packaged apps + installers), which packager refuses to copy into the app.
rmSync(join(desktopRoot, "dist"), { recursive: true, force: true });
await Promise.all(desktopBuildOptions.map(options => build(options)));
