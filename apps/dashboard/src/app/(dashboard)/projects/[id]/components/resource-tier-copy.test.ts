import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { RESOURCE_TIER_ORDER } from "@repo/core";
import { baseDictionary as en } from "@/i18n";

/**
 * Every tier this component renders must have copy — and a missing one must not be fatal.
 *
 * `RESOURCE_TIER_ORDER` (packages/core) decides which tiers exist and the Resources tab renders
 * all of them. `xlarge` was added there without its locale keys, so `r.tiers[tier].name` read
 * `undefined.name` and took the whole tab down with a runtime TypeError — a white screen for a
 * missing translation.
 *
 * Both halves are pinned: the keys exist NOW, and the accessor degrades if a future tier arrives
 * before its copy does. Locale data lags code by construction — nine files, five of which have no
 * `resources` block at all and inherit English — so the lag must be survivable.
 */
describe("every tier in RESOURCE_TIER_ORDER has English copy", () => {
  const tiers = en.projectSettings.resources.tiers as Record<string, { name?: string; description?: string }>;

  it.each([...RESOURCE_TIER_ORDER])("%s has a name and a description", (tier) => {
    expect(tiers[tier]?.name, `${tier}.name`).toBeTruthy();
    expect(tiers[tier]?.description, `${tier}.description`).toBeTruthy();
  });

  it("covers the unlimited pseudo-tier the picker prepends", () => {
    expect(tiers.unlimited?.name).toBeTruthy();
  });
});

describe("the accessor survives a tier with no copy", () => {
  const raw = readFileSync(new URL("./ResourceSettings.tsx", import.meta.url), "utf8");
  // CODE only. Matching the raw file made this fail on the doc comment that quotes the crashing
  // shape in order to explain it — a comment describing a bug is not the bug.
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("never hard-indexes the dictionary", () => {
    // The shape that crashed was `r.tiers[<expr>].name` — a direct index, no optional chain.
    expect(code).not.toMatch(/r\.tiers\[[^\]]+\]\.name/);
    expect(code).not.toMatch(/r\.tiers\[[^\]]+\]\.description/);
  });

  it("falls back to the tier id rather than throwing", () => {
    expect(code).toContain("tierCopy(tier)?.name ?? tier");
    expect(code).toContain('tierCopy(tier)?.description ?? ""');
  });
});
