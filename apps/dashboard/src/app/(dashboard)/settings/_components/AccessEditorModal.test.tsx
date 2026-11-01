// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { permissionsApi } from "@/lib/api";
import { AccessEditorModal } from "./AccessEditorModal";

const showToast = vi.hoisted(() => vi.fn());
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast }) }));

describe("AccessEditorModal", () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    host?.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("loads the resource catalog once after its labels update", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const neverSettles = new Promise<never>(() => {});
    const listResources = vi
      .spyOn(permissionsApi, "listResources")
      .mockResolvedValueOnce({ data: [{ id: "project-1", label: "Project One" }] } as never)
      .mockImplementation(() => neverSettles);

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <I18nProvider>
          <AccessEditorModal
            title="Member access"
            initial={[]}
            availableTypes={["project"]}
            onSave={() => {}}
            onClose={() => {}}
          />
        </I18nProvider>,
      );
    });

    expect(listResources).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Project One");
  });
});
