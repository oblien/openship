import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("ships a bootstrap matching the typed sources", () => {
  const script = fileURLToPath(
    new URL("../scripts/generate-package-manager-bootstrap.ts", import.meta.url),
  );
  const result = spawnSync("bun", [script, "--check"], { encoding: "utf8" });
  expect(result.status, result.stderr || result.error?.message).toBe(0);
});
