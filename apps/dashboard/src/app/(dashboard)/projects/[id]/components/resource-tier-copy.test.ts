import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RESOURCE_TIER_ORDER, type ResourceTier } from "@repo/core";
import { baseDictionary as en } from "@/i18n";
import { useResourceTierLabels } from "@/components/deploy/ResourceTierPicker";

let resources = structuredClone(en.projectSettings.resources);
vi.mock("@/components/i18n-provider", async original => ({
  ...await original<typeof import("@/components/i18n-provider")>(),
  useI18n: () => ({ t: { ...en, projectSettings: { ...en.projectSettings, resources } } }),
}));
beforeEach(() => { resources = structuredClone(en.projectSettings.resources); });

describe("resource tier translations", () => {
  it.each([...RESOURCE_TIER_ORDER, "unlimited"])("%s has English copy", tier => {
    const copy = (resources.tiers as Record<string, { name?: string; description?: string }>)[tier];
    expect(copy?.name).toBeTruthy();
    expect(copy?.description).toBeTruthy();
  });

  it.each(["micro", "xlarge"] as ResourceTier[])("renders %s safely when its translation has not arrived", tier => {
    delete (resources.tiers as Record<string, unknown>)[tier];
    let labels!: { name: string; description: string; spec: string };
    function Probe() {
      const copy = useResourceTierLabels();
      labels = { name: copy.name(tier), description: copy.description(tier), spec: copy.spec(tier, { cpuCores: 0, memoryMb: 0 }) };
      return createElement("span", null, labels.name);
    }
    expect(renderToStaticMarkup(createElement(Probe))).toContain(tier);
    expect(labels.name).toBe(tier);
    expect(labels.description).toBe("");
    expect(labels.spec).toContain("vCPU");
  });
});
