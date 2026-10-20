import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { flattenSettingFields, getAppSettings, getAppTemplate, validateSetting } from "@repo/core";
import { AppSettingsForm, buildChanges, fk, seedFormValues } from "./AppSettingsForm";
import type { AppSettingsView } from "@/lib/api/apps";

const groups = getAppSettings(getAppTemplate("webmail")!);
const fields = flattenSettingFields(groups);
const modelField = fields.find((field) => field.key === "MINIMAX_MODEL")!;

for (const saved of [undefined, "MiniMax-M3", "MiniMax-M2.7", "custom-model"]) {
  it(`renders and preserves ${saved ?? "the Flash default"} in webmail settings`, () => {
    const view = {
      groups,
      values: saved ? [{ service: "webmail", key: "MINIMAX_MODEL", set: true, value: saved }] : [],
    } as AppSettingsView;
    const values = seedFormValues(view);
    const model = saved ?? "MiniMax-M3.1-Flash";
    expect(values[fk("webmail", "MINIMAX_MODEL")]).toBe(model);
    expect(validateSetting(modelField, model)).toBeNull();
    expect(buildChanges(fields, values, values)).toEqual([]);
    const html = renderToStaticMarkup(
      <AppSettingsForm
        groups={groups}
        values={values}
        onChange={() => {}}
        secretSetLabel="Configured"
        showAdvanced
        filter={(field) => field.key === "MINIMAX_MODEL"}
      />,
    );
    expect(html).toContain(`value="${model}"`);
    expect(html).toContain('list="webmail-MINIMAX_MODEL-options"');
    expect(html).toContain('<option value="MiniMax-M3.1-Flash">');
    expect(html).toContain('<option value="MiniMax-M3">');
    expect(html).not.toContain('<option value="MiniMax-M2.7">');
    expect(html).not.toContain('<option value="custom-model">');
    const changed = { ...values, [fk("webmail", "MINIMAX_MODEL")]: "custom-model-v2" };
    expect(buildChanges(fields, changed, values)).toEqual([
      { service: "webmail", key: "MINIMAX_MODEL", value: "custom-model-v2" },
    ]);
  });
}
