// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_MASK } from "@repo/core";
import { I18nProvider } from "@/components/i18n-provider";
import { EnvironmentTimezone } from "./EnvironmentTimezone";
import type { EnvironmentVariableRow } from "./import-project/EnvironmentVariables";
import { computeProjectEnvDiff, createProjectEnvEditState } from "@/lib/project-env-diff";

let host: HTMLDivElement;
let root: Root;
let current: EnvironmentVariableRow[];
let setRows: (rows: EnvironmentVariableRow[]) => void;

function Editor({
  initial,
  disabled = false,
}: {
  initial: EnvironmentVariableRow[];
  disabled?: boolean;
}) {
  const [rows, update] = useState(initial);
  current = rows;
  setRows = update;
  return (
    <I18nProvider>
      <EnvironmentTimezone
        rows={rows}
        onChange={update}
        createRow={(value) => ({ key: "TZ", value, visible: true, isSecret: false })}
        disabled={disabled}
      />
    </I18nProvider>
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const trigger = () => host.querySelector<HTMLButtonElement>('button[aria-label="Timezone"]')!;
async function render(initial: EnvironmentVariableRow[], disabled = false) {
  await act(async () => root.render(<Editor initial={initial} disabled={disabled} />));
}
async function select(value: string) {
  await act(async () => trigger().click());
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (el) => el.textContent === value,
  );
  expect(option, value).toBeDefined();
  await act(async () => option!.click());
}

describe("environment timezone", () => {
  it("adds, edits and clears TZ through the existing environment diff, preserving secrets", async () => {
    const state = createProjectEnvEditState(
      [{ key: "TOKEN", value: ENV_MASK, isSecret: true, environment: "production" }],
      "production",
    );
    await render(state.rows);
    expect(current).toEqual(state.rows);
    await select("America/Caracas");
    expect(computeProjectEnvDiff(current, state.baseline)).toMatchObject({
      ok: true,
      diff: {
        upserts: [{ key: "TZ", value: "America/Caracas", isSecret: false }],
        deletes: [],
      },
    });
    await select("UTC");
    expect(current.filter((r) => r.key === "TZ")).toHaveLength(1);
    expect(current.find((r) => r.key === "TZ")?.value).toBe("UTC");
    await select("Image default (no TZ)");
    expect(current).toEqual(state.rows);
  });

  it("reflects manually edited and custom values and deletes a persisted TZ normally", async () => {
    const state = createProjectEnvEditState(
      [{ key: "TZ", value: "Etc/GMT+4", isSecret: false, environment: "production" }],
      "production",
    );
    await render(state.rows);
    expect(trigger().textContent).toContain("Etc/GMT+4");
    await act(async () => setRows(current.map((r) => ({ ...r, value: "Europe/Paris" }))));
    expect(trigger().textContent).toContain("Europe/Paris");
    await select("Image default (no TZ)");
    expect(computeProjectEnvDiff(current, state.baseline)).toMatchObject({
      ok: true,
      diff: {
        upserts: [],
        deletes: ["TZ"],
      },
    });
  });

  it.each([
    [{ key: "TZ", value: ENV_MASK, visible: false }],
    [{ key: "TZ", value: "", preserveValue: true, visible: false }],
    [
      { key: "TZ", value: "UTC", visible: true },
      { key: "TZ", value: "Europe/Paris", visible: true },
    ],
  ])("does not overwrite hidden or ambiguous TZ rows", async (...rows) => {
    await render(rows);
    expect(trigger().disabled).toBe(true);
    expect(current).toEqual(rows);
  });

  it("keeps inherited-row removal restrictions while allowing a deliberate override", async () => {
    const row = {
      key: "TZ",
      value: "UTC",
      visible: true,
      removalDisabled: true,
      sourceId: "compose",
    };
    await render([row]);
    await act(async () => trigger().click());
    expect(document.body.textContent).not.toContain("Image default (no TZ)");
    await act(async () => trigger().click());
    await select("America/Caracas");
    expect(current).toEqual([{ ...row, value: "America/Caracas", preserveValue: false }]);
  });

  it("respects the host editor's busy/read-only state", async () => {
    await render([], true);
    expect(trigger().disabled).toBe(true);
    expect(current).toEqual([]);
  });
});
