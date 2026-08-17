import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ValidationError } from "./errors";
import {
  OPERATOR_RECIPE_VERSION,
  exportContainsSecretKeys,
  parseOperatorRecipe,
  serializeMountedRelease,
} from "./project-config-export";

const RECIPE_DIR = fileURLToPath(new URL("../../../fixtures/operator-recipes/", import.meta.url));

const EXPECTED_FILES = [
  "ae-mail.json",
  "ae-public.json",
  "ae-staff.json",
  "dashwood.json",
  "lake-forest.json",
] as const;

function loadRaw(name: string): unknown {
  return JSON.parse(readFileSync(join(RECIPE_DIR, name), "utf8"));
}

const HOST_PATH = /(?:^|\/\/|")(?:\/home\/|\/root\/|\/Users\/|\/var\/lib\/openship\/)/;

describe("operator recipe fixtures", () => {
  const files = readdirSync(RECIPE_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort();

  it("commits the five app recipes", () => {
    expect(files).toEqual([...EXPECTED_FILES]);
  });

  it("round-trips each fixture without secret keys", () => {
    for (const file of files) {
      const raw = loadRaw(file);
      const text = JSON.stringify(raw);
      expect(exportContainsSecretKeys(raw), file).toBe(false);
      expect(text, file).not.toMatch(HOST_PATH);

      const recipe = parseOperatorRecipe(raw);
      expect(recipe.version).toBe(OPERATOR_RECIPE_VERSION);
      expect(exportContainsSecretKeys(recipe), file).toBe(false);

      const again = parseOperatorRecipe(JSON.parse(JSON.stringify(recipe)));
      expect(again, file).toEqual(recipe);
      expect(serializeMountedRelease(recipe.mountedRelease), file).toEqual(recipe.mountedRelease);
      expect(
        serializeMountedRelease({
          ...recipe.mountedRelease,
          cloneTokenEncrypted: "enc1:NO",
          webhookSecret: "whsec",
          unknown: "drop-me",
        }),
        file,
      ).toEqual(recipe.mountedRelease);
    }
  });

  it("keeps Dashwood prebuilt, Lake Forest upload, Mail image-off", () => {
    const dashwood = parseOperatorRecipe(loadRaw("dashwood.json"));
    expect(dashwood.buildMode).toBe("prebuilt");
    expect(dashwood.mountedRelease.enabled).toBe(true);
    expect(dashwood.mountedRelease.buildMode).toBe("prebuilt");
    expect(dashwood.mountedRelease.sourcePath).toBe("out");

    const lake = parseOperatorRecipe(loadRaw("lake-forest.json"));
    expect(lake.buildMode).toBe("upload");
    expect(lake.mountedRelease.enabled).toBe(true);
    expect(lake.mountedRelease.buildMode).toBe("prebuilt");
    expect(lake.persistPaths).toEqual(["storage", "database/database.sqlite"]);
    expect(lake.planner.backupPreset).toBe("sqlite");

    const mail = parseOperatorRecipe(loadRaw("ae-mail.json"));
    expect(mail.buildMode).toBe("image");
    expect(mail.mountedRelease.enabled).toBe(false);
    expect(mail.activation.strategy).toBe("image-replace");
    expect(mail.monorepoPathPrefixes).toEqual(["apps/mail"]);
  });

  it("scopes AE Public and Staff to their monorepo prefixes", () => {
    const pub = parseOperatorRecipe(loadRaw("ae-public.json"));
    const staff = parseOperatorRecipe(loadRaw("ae-staff.json"));
    expect(pub.monorepoPathPrefixes).toEqual(["apps/public"]);
    expect(staff.monorepoPathPrefixes).toEqual(["apps/staff"]);
    expect(pub.planner.pathPrefixes).not.toContain("apps/staff");
    expect(staff.planner.pathPrefixes).not.toContain("apps/public");
    expect(pub.service.key).toBe("public");
    expect(staff.service.key).toBe("staff");
  });
});

describe("parseOperatorRecipe", () => {
  it("refuses a payload that still contains a secret key", () => {
    expect(() =>
      parseOperatorRecipe({
        version: 1,
        name: "X",
        projectHint: "x",
        environment: "production",
        service: { key: "x", name: "web" },
        buildMode: "prebuilt",
        persistPaths: [],
        health: { path: "/" },
        activation: {
          strategy: "atomic-current",
          killDuringStaging: true,
          unhealthyRollsBack: true,
        },
        monorepoPathPrefixes: [],
        migrationPolicy: "none",
        rollbackPolicy: "none",
        mountedRelease: { enabled: true, containerPath: "/app", webhookSecret: "nope" },
        planner: { pathPrefixes: [] },
      }),
    ).toThrow(ValidationError);
  });
});
