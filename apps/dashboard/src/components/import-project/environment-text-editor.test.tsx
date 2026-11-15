// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_MASK } from "@repo/core";
import { I18nProvider } from "@/components/i18n-provider";
import EnvironmentVariables from "./EnvironmentVariables";
import { EnvironmentTextEditor } from "./EnvironmentTextEditor";
import type { EnvironmentVariableRow } from "./types";

let host: HTMLDivElement;
let root: Root;
const changed = vi.fn();
const reveal = vi.fn();

function Harness({
  initial,
  collapsible = false,
}: {
  initial: EnvironmentVariableRow[];
  collapsible?: boolean;
}) {
  const [rows, setRows] = useState(initial);
  return (
    <I18nProvider>
      <EnvironmentVariables
        mode="settings"
        isEditingMode
        showSettingsActions={false}
        collapsible={collapsible}
        envVars={rows}
        onReveal={reveal}
        onEnvVarsChange={(next) => {
          changed(next);
          setRows(next);
        }}
      />
    </I18nProvider>
  );
}

const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === label,
  )!;
async function edit(text: string) {
  const field = document.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("shared .env text editor", () => {
  it("rejects a draft when its source rows changed and reloads on reopening", async () => {
    const render = async (value: string) =>
      act(async () =>
        root.render(
          <I18nProvider>
            <EnvironmentTextEditor
              rows={[{ key: "PORT", value, visible: true }]}
              onChange={changed}
            />
          </I18nProvider>,
        ),
      );
    await render("3000");
    await act(async () => button("Edit as text").click());
    await edit("PORT=4000");
    await render("5000");
    await act(async () => button("Apply changes").click());
    expect(changed).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Variables changed");
    await act(async () => button("Cancel").click());
    await act(async () => button("Edit as text").click());
    expect(document.querySelector("textarea")?.value).toBe("PORT=5000\n");
  });

  it("adds at the top and expands collapsed variables", async () => {
    await act(async () =>
      root.render(
        <Harness collapsible initial={[{ key: "PORT", value: "3000", visible: true }]} />,
      ),
    );
    await act(async () => button("Add Variable").click());
    expect(changed).toHaveBeenLastCalledWith([
      { key: "", value: "", visible: true },
      { key: "PORT", value: "3000", visible: true },
    ]);
    expect(host.querySelector<HTMLInputElement>('[data-env-index="0"] input')?.value).toBe("");
  });

  it("applies text through normal rows without revealing or replacing an unchanged secret", async () => {
    const secret = {
      key: "TOKEN",
      value: "",
      originalKey: "TOKEN",
      preserveValue: true,
      isSecret: true,
      visible: true,
    };
    await act(async () =>
      root.render(<Harness initial={[secret, { key: "PORT", value: "3000", visible: true }]} />),
    );
    await act(async () => button("Edit as text").click());
    expect(document.querySelector("textarea")?.value).toContain(`TOKEN=${ENV_MASK}`);
    await edit(`TOKEN=${ENV_MASK}\nPORT=4000\nADDED='literal $VALUE'`);
    expect(changed).not.toHaveBeenCalled();
    await act(async () => button("Apply changes").click());
    expect(reveal).not.toHaveBeenCalled();
    expect(changed.mock.calls[0][0]).toEqual([
      secret,
      { key: "PORT", value: "4000", visible: true, preserveValue: false },
      { key: "ADDED", value: "literal $VALUE", visible: true, preserveValue: false },
    ]);
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("keeps invalid drafts open and Cancel leaves existing rows intact", async () => {
    await act(async () =>
      root.render(<Harness initial={[{ key: "PORT", value: "3000", visible: true }]} />),
    );
    await act(async () => button("Edit as text").click());
    await edit("PORT=4000\nPORT=5000");
    await act(async () => button("Apply changes").click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("line 2");
    expect(changed).not.toHaveBeenCalled();
    await act(async () => button("Cancel").click());
    expect(document.querySelector("textarea")).toBeNull();
    expect(host.querySelector<HTMLInputElement>('[data-env-index="0"] input')?.value).toBe("PORT");
  });
});
