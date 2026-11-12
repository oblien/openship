// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ServerContainerStatus } from "@/lib/api/system";
import { ServerContainerUpdates } from "./container-updates";

const h = vi.hoisted(() => ({ list: vi.fn(), scan: vi.fn(), server: vi.fn(), fix: vi.fn(), install: vi.fn() }));
vi.mock("@/lib/api/system", () => ({ systemApi: {
  listServerContainers: h.list, scanServerContainers: h.scan, getServerById: h.server,
} }));
vi.mock("@/hooks/useInfraFix", () => ({ useInfraFix: () => h.fix }));
vi.mock("@/hooks/useSystemPrepareModal", () => ({ useServerEdgeInstallModal: () => h.install }));
vi.mock("@/hooks/useReattachActiveFix", () => ({ useReattachActiveFix: () => {} }));

const installed: ServerContainerStatus = {
  id: "edge-status", serverId: "restored-server", component: "edge",
  runningLabel: "ghcr.io/oblien/openship-edge:0.9.11",
  pinnedLabel: "ghcr.io/oblien/openship-edge:0.9.11-dev.fixture",
  runningVersion: "0.9.11", pinnedVersion: "0.9.11-dev.fixture",
  behind: true, latestInProgress: false, detail: null, checkedAt: "2026-11-12T00:00:00Z",
};
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.list.mockResolvedValue([]);
  h.server.mockResolvedValue({ projectCount: 1, edgeRequired: true });
  h.scan.mockResolvedValue({ ok: true, containers: [] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<ServerContainerUpdates serverId="restored-server" />));
}
async function scan() {
  const button = [...host.querySelectorAll("button")].find(node => node.textContent?.trim() === "Scan")!;
  await act(async () => button.click());
}

it("keeps an imported server unverified until a scan finds its production edge", async () => {
  await render();
  expect(host.textContent).toContain("Not checked");
  expect(host.textContent).not.toContain("Not installed");
  expect(host.textContent).not.toContain("nothing routing traffic");
  expect(host.textContent).not.toContain("Install edge");
  h.list.mockResolvedValue([installed]);
  await scan();
  expect(h.scan).toHaveBeenCalledExactlyOnceWith("restored-server");
  expect(host.textContent).toContain("0.9.11");
  expect(host.textContent).toContain("Update");
  expect(host.textContent).not.toContain("Install edge");
  expect(h.install).not.toHaveBeenCalled();
  expect(h.fix).not.toHaveBeenCalled();
});

it("offers installation only for a cached confirmed absence", async () => {
  h.list.mockResolvedValue([{ ...installed, runningLabel: null, runningVersion: null, behind: false,
    detail: { down: true, containerMissing: true } }]);
  await render();
  expect(host.textContent).toContain("Not installed");
  expect(host.textContent).toContain("Install edge");
  expect(host.textContent).toContain("nothing routing traffic");
});

it("preserves the detected production version when a cache refresh fails", async () => {
  h.list.mockResolvedValue([installed]);
  await render();
  h.list.mockRejectedValue(new Error("Cache temporarily unavailable"));
  await scan();
  expect(host.textContent).toContain("0.9.11");
  expect(host.textContent).toContain("Update");
  expect(host.textContent).not.toContain("Not installed");
});
