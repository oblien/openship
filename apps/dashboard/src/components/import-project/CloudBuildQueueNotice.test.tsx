// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CloudBuildQueueNotice } from "./CloudBuildQueueNotice";
import { CloudDeployPlanModal } from "@/components/billing/CloudDeployPlanModal";
import type { CloudBuildQueueStatus } from "@/context/deployment/types";
import { baseDictionary, loadDictionary, locales, type Locale } from "@/i18n";
import { interpolate } from "@/components/i18n-provider";

const modal = vi.hoisted(() => ({
  showModal: vi.fn((_config: any) => "modal-1"),
  hideModal: vi.fn(),
}));
let dictionary = baseDictionary;
let locale: Locale = "en";
vi.mock("@/components/i18n-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/i18n-provider")>()),
  useI18n: () => ({ t: dictionary, locale }),
}));
vi.mock("@/context/ModalContext", () => ({ useModal: () => modal }));
vi.mock("@/components/billing/CloudDeployPlanModal", () => ({ CloudDeployPlanModal: () => null }));
let root: Root;
let host: HTMLDivElement;
const queue: CloudBuildQueueStatus = {
  position: 2,
  reason: "concurrency",
  simultaneousBuilds: 1,
  activeBuilds: 1,
  workspaceId: "ws-1",
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  dictionary = baseDictionary;
  locale = "en";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render(value = queue) {
  await act(async () => root.render(<CloudBuildQueueNotice queue={value} />));
}
it("shows the queue without opening pricing; the optional action scopes the existing modal", async () => {
  await render();
  expect(host.textContent).toContain("Position 2");
  expect(host.textContent).toContain("Simultaneous builds allowed by your plan: 1.");
  expect(host.textContent).toContain("Upgrading is optional");
  expect(modal.showModal).not.toHaveBeenCalled();
  await act(async () => host.querySelector("button")!.click());
  const content = modal.showModal.mock.calls[0]![0].customContent;
  expect(content.type).toBe(CloudDeployPlanModal);
  expect(content.props.workspaceId).toBe("ws-1");
  expect(content.props.restriction).toEqual({
    code: "PLAN_UPGRADE_REQUIRED",
    reason: "build-concurrency",
    message: dictionary.deployments.cloudBuildQueue.compareConcurrency,
  });
  expect(content.props.onRetry).toBeUndefined();
  content.props.onClose();
  expect(modal.hideModal).toHaveBeenCalledWith("modal-1");
});
it.each([1, null])(
  "offers an optional resource upgrade with simultaneous allowance %s",
  async (simultaneousBuilds) => {
    await render({ ...queue, reason: "resources", simultaneousBuilds });
    expect(host.textContent).toContain(dictionary.deployments.cloudBuildQueue.resources);
    expect(modal.showModal).not.toHaveBeenCalled();
    await act(async () => host.querySelector("button")!.click());
    const content = modal.showModal.mock.calls[0]![0].customContent;
    expect(content.type).toBe(CloudDeployPlanModal);
    expect(content.props.workspaceId).toBe("ws-1");
    expect(content.props.restriction).toEqual({
      code: "PLAN_UPGRADE_REQUIRED",
      reason: "resource-tier",
      message: dictionary.deployments.cloudBuildQueue.compareResources,
    });
    expect(content.props.onRetry).toBeUndefined();
  },
);
it.each(["server", "concurrency"] as const)(
  "shows a %s wait without an upgrade action when there is no applicable plan limit",
  async (reason) => {
    await render({ ...queue, reason, position: null, simultaneousBuilds: null });
    expect(host.textContent).toContain("Build queued");
    expect(host.textContent).toContain("no simultaneous build limit");
    expect(host.textContent).not.toContain("Position");
    expect(host.querySelector("button")).toBeNull();
    expect(modal.showModal).not.toHaveBeenCalled();
  },
);
it("never offers a plan action for a server wait even with a finite allowance", async () => {
  await render({ ...queue, reason: "server" });
  expect(host.querySelector("button")).toBeNull();
});
it.each(locales)(
  "renders queue copy and the resource modal message in %s",
  async (selectedLocale) => {
    locale = selectedLocale;
    dictionary = await loadDictionary(locale);
    const copy = dictionary.deployments.cloudBuildQueue;
    const numbers = new Intl.NumberFormat(locale);
    await render({ ...queue, reason: "resources" });
    expect(host.querySelector("section")?.getAttribute("aria-label")).toBe(copy.label);
    for (const text of [
      copy.resources,
      copy.automaticStart,
      copy.optionalUpgrade,
      interpolate(copy.position, { position: numbers.format(2) }),
      interpolate(copy.allowance, { count: numbers.format(1) }),
      interpolate(copy.active, { count: numbers.format(1) }),
    ]) {
      expect(host.textContent).toContain(text);
    }
    expect(host.querySelector("button")?.textContent).toBe(copy.comparePlans);
    if (locale !== "en") {
      for (const key of Object.keys(copy) as (keyof typeof copy)[])
        expect(copy[key]).not.toBe(baseDictionary.deployments.cloudBuildQueue[key]);
      expect(host.textContent).not.toContain("Build queued");
      expect(host.textContent).not.toContain("Compare plans");
    }
    await act(async () => host.querySelector("button")!.click());
    expect(modal.showModal.mock.calls[0]![0].customContent.props.restriction.message).toBe(
      copy.compareResources,
    );
    await render({ ...queue, position: null, reason: "server", simultaneousBuilds: null });
    expect(host.textContent).toContain(copy.title);
    expect(host.textContent).toContain(copy.server);
    expect(host.textContent).toContain(copy.unlimited);
  },
);
