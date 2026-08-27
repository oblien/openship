import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static contract for the packaged API runtime.
 *
 * Docker-over-SSH depends on ssh2/dockerode running under Node. A previous
 * desktop build compiled the API into a Bun executable, where that transport
 * failed even though the same deployment worked under Node. These checks keep
 * staging, packaging, and launch in agreement without booting Electron.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const stage = read("../build/stage.ts");
const services = read("../src/main/services.ts");
const forge = read("../forge.config.js");

describe("packaged API runtime", () => {
  it("stages a Node bundle with the SSH/Docker dependencies external", () => {
    const buildOptions = stage.match(/Bun\.build\(\{([\s\S]*?)\n\s*\}\);/)?.[1] ?? "";

    expect(buildOptions).toMatch(/target:\s*["']node["']/);
    expect(buildOptions).toMatch(/naming:\s*["']index\.js["']/);
    for (const dependency of ["ssh2", "dockerode", "cpu-features"]) {
      expect(buildOptions, `Bun.build must externalize ${dependency}`).toContain(`"${dependency}"`);
    }

    expect(stage).toContain('join(serverDir, "package.json")');
    expect(stage).toMatch(/type:\s*["']module["']/);
  });

  it("ships the Node bundle and its external dependencies", () => {
    const extraResources = forge.match(/extraResource:\s*\[([\s\S]*?)\n\s*\],/)?.[1] ?? "";

    expect(extraResources).toContain('path.join(RESOURCES, "server")');
    expect(extraResources).toContain('path.join(RESOURCES, "node_modules")');
  });

  it("launches the API with Electron's Node, including the fallback path", () => {
    const startApi =
      services.match(
        /async function startApi\([\s\S]*?\n\}\n\n\/\*\*\n \* Start the bundled API/,
      )?.[0] ?? "";

    expect(services).toContain('apiEntry: join(root, "server", "index.js")');
    expect(startApi).toMatch(/utilityProcess\.fork\(apiEntry,/);
    expect(startApi).toMatch(/spawn\(process\.execPath,\s*\[apiEntry\]/);
    expect(startApi).toMatch(/ELECTRON_RUN_AS_NODE:\s*["']1["']/);
  });
});
