import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Static contract check across the three files that decide what the packaged
 * app can reach at runtime: build/stage.ts (what gets staged into resources/),
 * forge.config.js (what actually ships in the .app), and src/main/services.ts
 * (how the API is told where it landed).
 *
 * A payload staged but not shipped — or shipped but never handed to the API —
 * only fails in a packaged build, never in `bun dev`, because the dev layout
 * resolves the same files from the monorepo. That is exactly how the mail
 * engine regressed: the API fell back to a cwd-relative
 * `../../apps/email/engine`, which in the packaged app pointed two levels above
 * userData, and setup died at step 7 with "tar: could not chdir".
 * Pure text scan — no Electron runtime or packaged build needed.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const stage = read("../build/stage.ts");
const forge = read("../forge.config.js");
const services = read("../src/main/services.ts");

const matchAll = (src: string, re: RegExp) => [...src.matchAll(re)].map((m) => m[1]);

// Directories stage.ts writes under resources/. Build-scratch probe files
// (__ssh2-probe*) are created and removed within a step — not payload.
const staged = new Set(
  matchAll(stage, /join\(RESOURCES,\s*"([^"]+)"/g).filter((name) => !name.startsWith("__")),
);

// Directories forge copies into the packaged app (packagerConfig.extraResource).
const shipped = new Set(matchAll(forge, /path\.join\(RESOURCES,\s*"([^"]+)"\)/g));

describe("bundled resources contract", () => {
  it("every directory staged into resources/ is shipped via extraResource", () => {
    const missing = [...staged].filter((name) => !shipped.has(name));
    expect(missing, `stage.ts stages payload forge never ships: ${missing.join(", ")}`).toEqual([]);
  });

  it("every extraResource entry is actually staged by stage.ts", () => {
    const missing = [...shipped].filter((name) => !staged.has(name));
    expect(missing, `forge ships payload stage.ts never produces: ${missing.join(", ")}`).toEqual(
      [],
    );
  });

  it("the mail engine is staged, shipped, and located for the API (regression: setup step 7)", () => {
    expect(staged.has("mail-engine"), "stage.ts does not stage resources/mail-engine").toBe(true);
    expect(shipped.has("mail-engine"), "forge.config.js does not ship resources/mail-engine").toBe(
      true,
    );
    expect(
      /mailEngineDir:\s*join\(root,\s*"mail-engine"\)/.test(services),
      "resourcePaths() does not expose mailEngineDir",
    ).toBe(true);
    expect(
      /MAIL_SERVER_ENGINE_DIR:\s*mailEngineDir/.test(services),
      "the API is spawned without MAIL_SERVER_ENGINE_DIR — it would fall back to the monorepo path",
    ).toBe(true);
  });
});
