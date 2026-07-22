import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(PACKAGE_DIR, "test/fixtures/compiled-openresty-lua.ts");
const LUA_DIR = join(PACKAGE_DIR, "src/infra/lua");

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("compiled OpenResty Lua deployment", () => {
  it("reads every deployed script from the packaged Lua directory", () => {
    tempDir = mkdtempSync(join(tmpdir(), "openship-lua-"));
    const executable = join(tempDir, "deploy-lua");

    execFileSync("bun", ["build", FIXTURE, "--compile", "--outfile", executable], {
      cwd: PACKAGE_DIR,
      stdio: "pipe",
    });

    const output = execFileSync(executable, {
      encoding: "utf8",
      env: { ...process.env, OPENSHIP_LUA_DIR: LUA_DIR },
    });

    expect(JSON.parse(output)).toEqual([
      "site_logger.lua",
      "pipe_log.lua",
      "pipe_stream.lua",
      "mgmt_api.lua",
      "geo_country.lua",
      "rules_lib.lua",
      "rules_guard.lua",
    ]);
  });
});
