import { expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { defaultAppearance, createTheme } from "@repo/core";
import { UserSettingsSchemas } from "./settings";
it("REST and SDK share the complete versioned appearance shape", () => {
  const appearance = {
    ...defaultAppearance("personal"),
    themes: [createTheme("dark", "personal", "Personal")],
  };
  expect(Value.Check(UserSettingsSchemas.setAppearance.input, { appearance })).toBe(true);
  expect(Value.Check(UserSettingsSchemas.getAppearance.output, { appearance })).toBe(true);
  expect(Value.Check(UserSettingsSchemas.setAppearance.input, { appearance: null })).toBe(true);
  expect(
    Value.Check(UserSettingsSchemas.setAppearance.input, {
      appearance: { ...appearance, version: 2 },
    }),
  ).toBe(false);
});
