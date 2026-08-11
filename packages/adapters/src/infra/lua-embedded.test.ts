import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { generateEmbeddedModule } from "../../scripts/embed-lua";
import { EMBEDDED_LUA } from "./lua-embedded";

const HERE = dirname(fileURLToPath(import.meta.url));
const EMBEDDED_PATH = join(HERE, "lua-embedded.ts");
const LUA_DIR = join(HERE, "lua");

// Every script referenced by the installer / vhost builder MUST be embedded, so
// a compiled binary (no filesystem path) can still install the edge. This list
// mirrors LUA_SCRIPTS in openresty-lua.ts.
const REQUIRED = [
  "site_logger.lua",
  "pipe_log.lua",
  "pipe_stream.lua",
  "mgmt_api.lua",
  "geo_country.lua",
  "rules_lib.lua",
  "rules_guard.lua",
];

describe("lua-embedded", () => {
  it("is in sync with lua/*.lua (run `bun run embed:lua` if this fails)", () => {
    const current = readFileSync(EMBEDDED_PATH, "utf-8");
    expect(current).toBe(generateEmbeddedModule());
  });

  it("embeds every installer-referenced script, decodable + non-empty", () => {
    for (const name of REQUIRED) {
      const b64 = EMBEDDED_LUA[name];
      expect(b64, `${name} must be embedded`).toBeTypeOf("string");
      const decoded = Buffer.from(b64, "base64").toString("utf-8");
      expect(decoded.length, `${name} must be non-empty`).toBeGreaterThan(0);
      // Decoded bytes must exactly reproduce the on-disk source.
      expect(decoded).toBe(readFileSync(join(LUA_DIR, name), "utf-8"));
    }
  });
});
