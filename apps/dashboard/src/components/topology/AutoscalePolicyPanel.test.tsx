// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { AutoscalePolicyPanel } from "./AutoscalePolicyPanel";
const h = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), events: vi.fn() }));
vi.mock("@/lib/api/project-autoscale", () => ({ projectAutoscaleApi: h }));
vi.mock("@/lib/api", () => ({
  getApiErrorCode: (error: { code?: string }) => error.code,
  getApiErrorMessage: (error: Error, fallback: string) => error.message ?? fallback,
}));
const saved = {
  projectId: "project",
  enabled: true,
  targetCpuPercent: 70,
  minReplicas: 1,
  maxReplicas: 6,
  stepSize: 1,
  cooldownSeconds: 120,
  suspendAfterFailures: 3,
  suspendedAt: null,
  suspendedReason: null,
  lastDecision: null,
  updatedAt: "2026-10-23T10:00:00Z",
};
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.get.mockResolvedValue(saved);
  h.events.mockResolvedValue({ events: [] });
  h.set.mockResolvedValue(saved);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const render = async (projectId = "project", disabled = false) => {
  await act(async () =>
    root.render(<AutoscalePolicyPanel projectId={projectId} clusterReady disabled={disabled} />),
  );
};
it("does not fetch policies for a hidden/unavailable panel", async () => {
  await render("project", true);
  expect(h.get).not.toHaveBeenCalled();
  expect(h.events).not.toHaveBeenCalled();
});
it("an API failure is not treated as a missing policy and cannot enable defaults", async () => {
  h.get.mockRejectedValue(Object.assign(new Error("Permission denied"), { code: "FORBIDDEN" }));
  await render();
  expect(host.textContent).toContain("Permission denied");
  expect(host.querySelector('[aria-label="Enable autoscaling"]')).toBeNull();
  expect(host.textContent).toContain("Retry loading autoscaling");
});
it("switching to a project without a policy clears the old enabled value", async () => {
  await render();
  h.get.mockRejectedValueOnce({ code: "AUTOSCALE_POLICY_ABSENT" });
  await render("new-project");
  const checkbox = host.querySelector<HTMLButtonElement>('[role="checkbox"]')!;
  expect(checkbox.getAttribute("aria-checked")).toBe("false");
  await act(async () => checkbox.click());
  expect(h.set).not.toHaveBeenCalled();
  const save = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Save policy"),
  )!;
  await act(async () => save.click());
  expect(h.set).toHaveBeenCalledWith(
    "new-project",
    expect.objectContaining({ enabled: true, expectedUpdatedAt: null }),
  );
});
it("saving a policy does not report failure just because refreshing history would fail", async () => {
  await render();
  h.events.mockRejectedValue(new Error("history offline"));
  const checkbox = host.querySelector<HTMLButtonElement>('[role="checkbox"]')!;
  await act(async () => checkbox.click());
  const save = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Save policy"),
  )!;
  await act(async () => save.click());
  expect(h.set).toHaveBeenCalledTimes(1);
  expect(h.events).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
