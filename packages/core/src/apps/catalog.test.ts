import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildCatalog } from "../../scripts/gen-catalog";
import { isValidAppTemplate } from "./schema";
import { APP_TEMPLATES } from "../app-templates";

const committed = JSON.parse(
  readFileSync(fileURLToPath(new URL("./catalog.json", import.meta.url)), "utf8"),
);

describe("app catalog (JSON)", () => {
  it("catalog.json is in sync with apps/catalog/*.json (run `bun scripts/gen-catalog.ts`)", () => {
    expect(buildCatalog()).toEqual(committed);
  });

  it("every bundled app validates against the shape schema", () => {
    for (const app of APP_TEMPLATES) {
      expect(isValidAppTemplate(app), `${app.id} failed schema`).toBe(true);
    }
  });

  it("rejects a malformed template (missing required fields)", () => {
    expect(isValidAppTemplate({ id: "x" })).toBe(false);
    expect(isValidAppTemplate(null)).toBe(false);
    expect(isValidAppTemplate({ id: "x", name: "X", description: "d", kind: "template", logo: "x", category: "bogus" })).toBe(false);
  });
});
