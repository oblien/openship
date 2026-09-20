import { plugin } from "bun";

/**
 * Lets `bun test` run this package's vitest files unchanged.
 *
 * The suite runs on Node (vitest, Node 22) but the product runs on Bun, so a green suite
 * is not evidence for stream, fs or spawn behavior. `docker-ssh-agent.test.ts` documents
 * three Bun-only stream bugs and could not be run under Bun at all: it imports from
 * `vitest`, which Bun's runner does not provide, and importing the real package outside
 * `vitest run` throws on its internal state. Bun's `bun:test` exports the same
 * describe/it/expect/afterEach names, so a virtual module is the whole adapter.
 */
plugin({
  name: "vitest-as-bun-test",
  setup(build) {
    build.module("vitest", () => ({
      contents: `export * from "bun:test";`,
      loader: "ts",
    }));
  },
});
