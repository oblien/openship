// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { baseDictionary } from "@/i18n";
import { EmptyVolumeDialog } from "./EmptyVolumeDialog";
import { emptyVolumePlan } from "./empty-volume-plan";
vi.mock("@/components/ui/Modal", () => ({
  Modal: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
}));
const copy = baseDictionary.projectDetail.services.detail.storage;
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
function button(label: string) {
  const result = [...host.querySelectorAll("button")].find((node) => node.textContent === label);
  expect(result).toBeDefined();
  return result!;
}
async function confirm() {
  await act(async () => {
    const input = host.querySelector("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "postgres",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function render(onReset = vi.fn().mockResolvedValue({ configured: true, started: true })) {
  const volumes = ["postgres_data:/var/lib/postgresql/data:rw,nocopy", "shared:/shared:ro"];
  const plan = emptyVolumePlan(volumes, volumes[0]!)!;
  const onClose = vi.fn();
  await act(async () =>
    root.render(
      <I18nProvider>
        <EmptyVolumeDialog name="postgres" plan={plan} onReset={onReset} onClose={onClose} />
      </I18nProvider>,
    ),
  );
  return { plan, onReset, onClose };
}
describe("start with empty storage", () => {
  it("uses a distinct named volume at the same path and preserves other mounts", () => {
    const volumes = ["pg_data:/var/lib/postgresql/data:rw,nocopy", "shared:/shared:ro"];
    const plan = emptyVolumePlan(volumes, volumes[0]!)!;
    expect(plan.previous).toBe("pg_data");
    expect(plan.volumes).toEqual([`${plan.source}:/var/lib/postgresql/data:rw,nocopy`, volumes[1]]);
    expect(volumes[0]).toBe("pg_data:/var/lib/postgresql/data:rw,nocopy");
    expect(emptyVolumePlan(volumes, volumes[0]!)!.source).not.toBe(plan.source);
  });
  it.each(["/host/data:/data", "./data:/data", "/data", "pg_data:/data:ro"])(
    "refuses unsupported mount %s",
    (mount) => {
      expect(emptyVolumePlan([mount], mount)).toBeNull();
    },
  );
  it("refuses stale selections and duplicate destinations", () => {
    expect(emptyVolumePlan(["other:/data"], "old:/data")).toBeNull();
    expect(emptyVolumePlan(["old:/data", "other:/data"], "old:/data")).toBeNull();
  });
  it("requires confirmation and lets Cancel leave configuration untouched", async () => {
    const { onReset, onClose } = await render();
    expect(button(copy.emptyVolume.action).disabled).toBe(true);
    await act(async () => button(copy.cancel).click());
    expect(onClose).toHaveBeenCalledOnce();
    expect(onReset).not.toHaveBeenCalled();
  });
  it("retries deployment using the same saved volume without rotating again", async () => {
    const onReset = vi
      .fn()
      .mockResolvedValueOnce({ configured: true, started: false })
      .mockResolvedValueOnce({ configured: true, started: true });
    const { plan, onClose } = await render(onReset);
    await confirm();
    await act(async () => button(copy.emptyVolume.action).click());
    expect(onReset).toHaveBeenLastCalledWith(plan.volumes, false);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(copy.emptyVolume.retryHint);
    expect(onClose).not.toHaveBeenCalled();
    expect(button(baseDictionary.projectDetail.services.addModal.close)).toBeDefined();
    await act(async () => button(copy.emptyVolume.retry).click());
    expect(onReset).toHaveBeenLastCalledWith(plan.volumes, true);
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("keeps failed configuration visible and prevents duplicate submissions", async () => {
    let fail!: (error: Error) => void;
    const onReset = vi.fn().mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
    );
    const { onClose } = await render(onReset);
    await confirm();
    await act(async () => {
      button(copy.emptyVolume.action).click();
      button(copy.emptyVolume.action).click();
    });
    expect(onReset).toHaveBeenCalledOnce();
    expect(button(copy.cancel).disabled).toBe(true);
    await act(async () => fail(new Error("Configuration changed; reload first")));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Configuration changed");
    expect(onClose).not.toHaveBeenCalled();
    expect(button(copy.emptyVolume.action).disabled).toBe(false);
  });
});
