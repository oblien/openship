import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Host-control paths must run through createHostExecutor() — LocalExecutor when
 * bare, SSH→host.docker.internal when containerized (OPENSHIP_HOST_SSH_*). A
 * no-arg createExecutor() is ALWAYS LocalExecutor, which in Docker-deployed mode
 * silently probes the api container's own netns instead of the host (the
 * "single switchable executor" fix). This guards against regressing to it.
 *
 * self-edge.ts is intentionally excluded: it early-returns in docker-edge mode
 * and its createExecutor() only runs bare, where local IS the host.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const HOST_CONTROL_FILES = [
  "../../src/lib/startup/self-deploy.ts",
  "../../src/modules/system/self-app.controller.ts",
];

describe("host-control executor guard", () => {
  for (const rel of HOST_CONTROL_FILES) {
    it(`${rel} uses createHostExecutor, not no-arg createExecutor()`, () => {
      const src = read(rel);
      const noArg = [...src.matchAll(/\bcreateExecutor\(\s*\)/g)];
      expect(noArg.length, "no-arg createExecutor() found — use createHostExecutor()").toBe(0);
      expect(src.includes("createHostExecutor")).toBe(true);
    });
  }
});
