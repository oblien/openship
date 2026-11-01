// @vitest-environment happy-dom
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettingField, AppSettingGroup } from "@repo/core";
import { AppSettingsForm, fk, withSettingDefaults, type FormValue } from "./AppSettingsForm";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(node: ReactNode) {
  await act(async () => root.render(node));
}

const groups: AppSettingGroup[] = [
  {
    id: "general",
    label: "General",
    columns: 2,
    fields: [
      {
        service: "api",
        key: "MODE",
        label: "Connection mode",
        type: "select",
        options: [
          { value: "auto", label: "Automatic" },
          { value: "custom", label: "Custom" },
        ],
        installStep: true,
      },
      {
        service: "api",
        key: "URL",
        label: "Endpoint URL",
        type: "text",
        installStep: true,
        required: true,
        pattern: "^https://",
        showIf: { field: "MODE", equals: "custom" },
        fullWidth: true,
      },
      {
        service: "api",
        key: "TOKEN",
        label: "API token",
        type: "password",
        secret: true,
        required: true,
        installStep: true,
      },
    ],
  },
  {
    id: "maintenance",
    label: "Maintenance",
    fields: [
      { service: "api", key: "LATER", label: "After install", type: "text", required: true },
    ],
  },
];

describe("catalog settings layouts", () => {
  it("initializes API-added fields without overwriting edits or cleared values", () => {
    const existing: AppSettingField[] = [
      { service: "api", key: "NAME", label: "Name", type: "text", default: "Default name" },
      { service: "api", key: "LABEL", label: "Label", type: "text", default: "Default label" },
      { service: "api", key: "ENABLED", label: "Enabled", type: "boolean", default: "true" },
    ];
    const edited = {
      ...withSettingDefaults(existing),
      "api NAME": "My name",
      "api LABEL": "",
      "api ENABLED": false,
    };
    const updated = withSettingDefaults(
      [
        ...existing,
        { service: "api", key: "MODE", label: "Mode", type: "text", default: "automatic" },
        { service: "worker", key: "NAME", label: "Worker name", type: "text", default: "Worker" },
      ],
      edited,
    );

    expect(updated).toEqual({ ...edited, "api MODE": "automatic", "worker NAME": "Worker" });
    expect(edited).not.toHaveProperty("api MODE");
  });

  it("keeps the project name visible when a single card has no visible settings", async () => {
    await render(
      <AppSettingsForm
        groups={groups}
        values={{}}
        onChange={() => {}}
        secretSetLabel="Already set"
        filter={() => false}
        flat
        columns={2}
        title="App settings"
        leadingContent={<input aria-label="Project name" defaultValue="My app" />}
      />,
    );

    expect(container.querySelectorAll("input")).toHaveLength(1);
    expect(container.querySelector("input")?.value).toBe("My app");
    expect(container.querySelector("h3")?.textContent).toBe("App settings");
  });

  it.each([true, false])("keeps visibility, values, and validation with flat=%s", async (flat) => {
    const onValidityChange = vi.fn();
    function Form({ flattened }: { flattened: boolean }) {
      const [values, setValues] = useState<Record<string, FormValue>>({ "api MODE": "auto" });
      return (
        <AppSettingsForm
          groups={groups}
          values={values}
          onChange={(field, value) =>
            setValues((prev) => ({ ...prev, [fk(field.service, field.key)]: value }))
          }
          secretSetLabel="Already set"
          isSet={(field) => field.secret === true}
          filter={(field) => field.installStep === true}
          flat={flattened}
          columns={2}
          title="App settings"
          onValidityChange={onValidityChange}
        />
      );
    }

    await render(<Form flattened={flat} />);
    expect(container.querySelector("h3")?.textContent).toBe(flat ? "App settings" : "General");
    expect(container.textContent).not.toContain("Maintenance");
    expect(container.textContent).not.toContain("Endpoint URL");
    // Hidden required fields and an unchanged stored secret must not block install.
    expect(onValidityChange).toHaveBeenLastCalledWith({
      valid: true,
      hasErrors: false,
      missingRequiredKeys: [],
    });

    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!.click(),
    );
    const custom = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent === "Custom",
    );
    expect(custom).toBeDefined();
    await act(async () => custom!.click());
    expect(onValidityChange).toHaveBeenLastCalledWith({
      valid: false,
      hasErrors: false,
      missingRequiredKeys: ["api URL"],
    });

    const input = container.querySelector<HTMLInputElement>('input[type="text"]')!;
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    async function fill(value: string) {
      await act(async () => {
        valueSetter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }

    await fill("invalid");
    expect(onValidityChange).toHaveBeenLastCalledWith({
      valid: false,
      hasErrors: true,
      missingRequiredKeys: [],
    });
    await fill("https://api.example.test");
    expect(onValidityChange).toHaveBeenLastCalledWith({
      valid: true,
      hasErrors: false,
      missingRequiredKeys: [],
    });

    // A refreshed template can change presentation without resetting the parent's values.
    await render(<Form flattened={!flat} />);
    expect(container.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe(
      "https://api.example.test",
    );
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe("");
  });
});
