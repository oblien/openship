import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasNoApplicableRuntime,
  parseRuntimeProbe,
  runtimeVersionProbe,
} from "@repo/platform/engine/modules/updates/runtime-probes";

const paths: string[] = [];
afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const path = mkdtempSync(join(tmpdir(), "openship-runtime-probe-"));
  paths.push(path);
  return path;
}

function run(path: string) {
  return execFileSync("/bin/sh", ["-c", runtimeVersionProbe(["node", "bun", "php"])], {
    env: { PATH: path },
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 16_384,
  });
}

it("proves absence when none of the requested runtimes is installed", () => {
  const output = run(fixture());
  expect(hasNoApplicableRuntime(output)).toBe(true);
  expect(parseRuntimeProbe(output, "service")).toEqual([]);
});

it("does not mistake an installed but broken runtime for an absent runtime", () => {
  const path = fixture();
  symlinkSync("/usr/bin/head", join(path, "head"));
  writeFileSync(
    join(path, "php"),
    "#!/bin/sh\nprintf 'error loading shared libraries\\n' >&2\nexit 1\n",
    {
      mode: 0o700,
    },
  );
  const output = run(path);
  expect(hasNoApplicableRuntime(output)).toBe(false);
  expect(parseRuntimeProbe(output, "service")).toEqual([]);
});

it("continues to collect real version output when a requested runtime exists", () => {
  const path = fixture();
  symlinkSync("/usr/bin/head", join(path, "head"));
  writeFileSync(join(path, "php"), "#!/bin/sh\nprintf 'PHP 8.5.12 (cli)\\n'\n", { mode: 0o700 });
  const output = run(path);
  expect(hasNoApplicableRuntime(output)).toBe(false);
  expect(parseRuntimeProbe(output, "service")).toEqual([
    { serviceId: "service", runtime: "php", version: "8.5.12" },
  ]);
});
