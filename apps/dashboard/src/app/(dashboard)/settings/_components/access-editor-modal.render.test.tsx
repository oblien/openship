// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const pending: Array<(value: { data: { id: string; label: string }[] }) => void> = [];
  return {
    pending,
    listResources: vi.fn(
      () =>
        new Promise<{ data: { id: string; label: string }[] }>((resolve) => pending.push(resolve)),
    ),
  };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    permissionsApi: { ...actual.permissionsApi, listResources: mocks.listResources },
  };
});

import { I18nProvider } from "@/components/i18n-provider";
import { ToastProvider } from "@/context/ToastContext";
import { AccessEditorModal } from "./AccessEditorModal";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.listResources.mockClear();
  mocks.pending.length = 0;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("AccessEditorModal", () => {
  it("loads the resource catalog once instead of refetching in a loop", async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <ToastProvider>
            <AccessEditorModal
              title="member@example.com"
              initial={[]}
              availableTypes={["project"]}
              show={{ templates: false, readOnlySwitch: false, createCapability: false }}
              suppressWildcardTypes={[]}
              onSave={() => {}}
              onClose={() => {}}
            />
          </ToastProvider>
        </I18nProvider>,
      );
    });
    expect(mocks.listResources).toHaveBeenCalledTimes(1);

    await act(async () => {
      mocks.pending[0]!({ data: [{ id: "proj_1", label: "Project one" }] });
    });

    expect(mocks.listResources).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Project one");
  });
});
