// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { swarmFixture } from "../../../../../packages/contracts/test/swarm-fixture";

const h = vi.hoisted(() => ({ inspect: vi.fn(), connect: vi.fn(), push: vi.fn(), platform: { selfHosted: true, deployMode: "docker" }, scope: "instance-a:org-a" }));
vi.mock("next/navigation", () => ({useRouter: () => ({push: h.push})}));
vi.mock("@/lib/api/system", () => ({ systemApi: { inspectSwarm: h.inspect, connectSwarm: h.connect } }));
vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => h.platform }));
vi.mock("@/context/CloudResourceContext", () => ({ useCloudResourceKey: () => h.scope }));
vi.mock("@repo/core/diagnostics", () => ({ reportCaughtError: vi.fn() }));
vi.mock("@repo/ui/icons", () => ({ Icon: () => null }));
import { ServerSwarm } from "./ServerSwarm";

let root: Root, element: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  h.scope = "instance-a:org-a";
  h.platform = { selfHosted: true, deployMode: "docker" };
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
  h.inspect.mockResolvedValue({ ...swarmFixture(), inventory: null });
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  vi.unstubAllGlobals();
});
const render = () => act(async () => root.render(<ServerSwarm serverId="server-a" />));
const click = async (label: string) => {
  const button = [...element.querySelectorAll("button")].find(
    (button) => button.textContent === label,
  );
  expect(button, label).toBeTruthy();
  await act(async () => button!.click());
};

it("loads inventory only on request and preserves it with a visible retry on connection failure", async () => {
  await render();
  expect(h.inspect).toHaveBeenCalledWith("server-a", false);
  expect(element.textContent).not.toContain("shop_web");
  h.inspect.mockResolvedValueOnce(swarmFixture());
  await click("Review stacks");
  expect(element.textContent).toContain("shop_web");
  expect(element.textContent).toContain("1 / 2 tasks");
  h.inspect.mockRejectedValueOnce(new Error("Connection lost"));
  await click("Refresh");
  expect(element.querySelector('[role="alert"]')?.textContent).toContain("Connection lost");
  expect(element.textContent).toContain("last successful observation");
  expect(element.textContent).toContain("shop_web");
  h.inspect.mockResolvedValueOnce(swarmFixture());
  await click("Refresh");
  expect(element.querySelector('[role="alert"]')).toBeNull();
});

it("discards old inventory and late results when the active organization changes", async () => {
  let resolve!: (value: ReturnType<typeof swarmFixture>) => void;
  h.inspect.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await render();
  h.scope = "instance-a:org-b";
  h.inspect.mockResolvedValueOnce({
    ...swarmFixture(),
    state: "inactive",
    role: null,
    inventory: null,
  });
  await render();
  await act(async () => resolve(swarmFixture()));
  expect(element.textContent).toBe("");
});

it("guides a worker to a manager without offering adoption or pretending the cluster is empty", async () => {
  h.inspect.mockResolvedValueOnce({ ...swarmFixture(), role: "worker", inventory: null });
  await render();
  expect(element.querySelector("a")?.getAttribute("href")).toBe("/servers/new");
  expect(element.textContent).toContain("Connect a manager");
  expect(element.textContent).not.toContain("Review stacks");
  expect(element.textContent).not.toContain("No Swarm services");
});

it("reuses a connection request after a lost response and opens the shared cluster page", async () => {
  await render();
  h.connect.mockRejectedValueOnce(new Error("Connection lost"));
  await click("Use for deployments");
  const request = h.connect.mock.calls[0]![1];
  h.connect.mockResolvedValueOnce({id: "swarm-cluster"});
  await click("Use for deployments");
  expect(h.connect).toHaveBeenLastCalledWith("server-a", request);
  expect(h.push).toHaveBeenCalledWith("/servers/clusters/swarm-cluster");
});

it("does not offer Swarm or inspect a host through the Cloud controller", async () => {
  h.platform = { selfHosted: false, deployMode: "docker" };
  await render();
  expect(element.textContent).toBe("");
  expect(h.inspect).not.toHaveBeenCalled();
  expect(h.connect).not.toHaveBeenCalled();
});

it("keeps Swarm available from Desktop", async () => {
  h.platform = { selfHosted: false, deployMode: "desktop" };
  await render();
  expect(h.inspect).toHaveBeenCalledWith("server-a", false);
});
