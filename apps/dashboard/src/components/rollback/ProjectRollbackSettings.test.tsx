// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import { ProjectRollbackSettings } from "./ProjectRollbackSettings";

const h = vi.hoisted(() => ({ load: vi.fn(), update: vi.fn(), invalidate: vi.fn(), toast: vi.fn() }));
vi.mock("@/lib/api", () => ({
  projectsApi: { getRollbackCapacity: h.load, update: h.update },
  getApiErrorMessage: (err: Error) => err.message,
}));
vi.mock("@/hooks/useProjectEndpoints", () => ({ invalidateProjectCaches: h.invalidate }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: h.toast }) }));
vi.mock("@/components/i18n-provider", () => ({
  useI18n: () => ({ t: baseDictionary }),
  interpolate: (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? key),
}));

const capacity = (window = 5) => ({ data: {
  window, explicit: null, source: "instance-default", maxWindow: 20,
  strategy: "git", snapshotSizeBytes: null, measuredAt: null,
  diskFreeBytes: null, diskTotalBytes: null, diskBudgetFraction: 0.25,
} });
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.load.mockReset().mockResolvedValue(capacity());
  h.update.mockReset().mockResolvedValue({});
  h.invalidate.mockReset();
  h.toast.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const render = async (id = "project") => act(async () => root.render(<ProjectRollbackSettings projectId={id} artifactKind="image" />));
function button(label: string) {
  const node = [...container.querySelectorAll("button")].find((node) => node.getAttribute("aria-label") === label || node.textContent === label);
  expect(node, label).toBeDefined();
  return node!;
}
const click = async (label: string) => act(async () => button(label).click());

it("shows the enforced default and explains the active/pinned exceptions", async () => {
  await render();
  expect(container.textContent).toContain("5 versions");
  expect(container.textContent).toContain("instance default");
  expect(container.textContent).toContain("Active and pinned releases are extra");
  expect(button("Decrease rollback history").disabled).toBe(false);
});

it("waits for persisted settings before allowing destructive limit changes", async () => {
  let complete!: (value: ReturnType<typeof capacity>) => void;
  h.load.mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
  await render();
  expect(container.textContent).not.toContain("5 versions");
  expect(container.querySelector('[aria-label="Decrease rollback history"]')).toBeNull();
  await act(async () => complete(capacity(8)));
  expect(container.textContent).toContain("8 versions");
  expect(button("Decrease rollback history").disabled).toBe(false);
});

it("reports a failed read and retries instead of editing a guessed default", async () => {
  h.load.mockRejectedValueOnce(new Error("Host unavailable"));
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Host unavailable");
  expect(container.querySelector('[aria-label="Decrease rollback history"]')).toBeNull();
  await click("Try again");
  expect(container.textContent).toContain("5 versions");
  expect(h.update).not.toHaveBeenCalled();
});

it("saves once while cleanup runs, then displays the reloaded value", async () => {
  await render();
  let complete!: () => void;
  h.update.mockReturnValueOnce(new Promise<void>((resolve) => { complete = resolve; }));
  await act(async () => {
    button("Decrease rollback history").click();
    button("Decrease rollback history").click();
  });
  expect(h.update).toHaveBeenCalledExactlyOnceWith("project", { rollbackWindow: 4 });
  expect(button("Increase rollback history").disabled).toBe(true);
  expect((container.querySelector('[role="switch"]') as HTMLButtonElement).disabled).toBe(true);
  h.load.mockResolvedValueOnce(capacity(4));
  await act(async () => complete());
  expect(container.textContent).toContain("4 versions");
  expect(h.invalidate).toHaveBeenCalledWith("project");
});

it("keeps the last saved value after an update fails", async () => {
  await render();
  h.update.mockRejectedValueOnce(new Error("Save failed"));
  await click("Decrease rollback history");
  expect(container.textContent).toContain("5 versions");
  expect(h.toast).toHaveBeenCalledWith("Save failed", "error");
  expect(h.invalidate).not.toHaveBeenCalled();
  expect(button("Decrease rollback history").disabled).toBe(false);
});

it("disables editing if the refresh after a save fails", async () => {
  await render();
  h.load.mockRejectedValueOnce(new Error("Reload failed"));
  await click("Decrease rollback history");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Reload failed");
  expect(container.querySelector('[aria-label="Decrease rollback history"]')).toBeNull();
});

it("aborts a stale project's read and ignores its late response", async () => {
  let complete!: (value: ReturnType<typeof capacity>) => void;
  h.load.mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
  await render("old");
  const oldSignal = h.load.mock.calls[0]![1] as AbortSignal;
  h.load.mockResolvedValueOnce(capacity(2));
  await render("new");
  expect(oldSignal.aborted).toBe(true);
  await act(async () => complete(capacity(19)));
  expect(container.textContent).toContain("2 versions");
  expect(container.textContent).not.toContain("19 versions");
});

it.each([0, 20])("bounds the stepper at %i", async (window) => {
  h.load.mockResolvedValueOnce(capacity(window));
  await render();
  expect(button(window === 0 ? "Decrease rollback history" : "Increase rollback history").disabled).toBe(true);
});
