import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as settings from "./MountedReleaseSettings";
import { applyPresetToDraft, emptyReleaseConfig, payloadFromDraft } from "./release-recipe";

const here = dirname(fileURLToPath(import.meta.url));

describe("release recipe wizard", () => {
  it("exports MountedReleaseSettings as the only settings component", () => {
    const fns = Object.entries(settings).filter(([, value]) => typeof value === "function");
    expect(fns.map(([name]) => name)).toEqual(["MountedReleaseSettings"]);
    expect(typeof settings.MountedReleaseSettings).toBe("function");
  });

  it("keeps the BuildSettings import pointing at this wizard", () => {
    const src = readFileSync(join(here, "BuildSettings.tsx"), "utf8");
    expect(src).toContain('from "./MountedReleaseSettings"');
    expect(src).toContain("<MountedReleaseSettings");
    expect(src).not.toMatch(/ReleaseRecipeWizard|MountedReleaseForm/);
  });

  it("applying Laravel fills a persistable recipe", () => {
    const draft = applyPresetToDraft(emptyReleaseConfig, "laravel");
    const payload = payloadFromDraft(draft);
    expect(payload.preset).toBe("laravel");
    expect(payload.buildMode).toBe("prebuilt");
    expect(payload.healthPath).toBe("/up");
    expect(payload.sharedPaths).toEqual(expect.arrayContaining(["storage", "bootstrap/cache"]));
    expect(payload.prepareCommand).toMatch(/migrate --force/);
  });
});
