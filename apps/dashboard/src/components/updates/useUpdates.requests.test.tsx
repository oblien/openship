// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UseUpdates } from "./useUpdates";
vi.mock("@/hooks/useDeploymentInfo", () => ({
  useDeploymentInfo: () => ({ selfHosted: true, version: "0.1.0" }),
}));
vi.mock("@/lib/api/urls", () => ({ getRestApiBaseUrl: () => "http://localhost:4000/api" }));

const snapshot = {
  latest: { tag: "v99.0.0", version: "99.0.0", notes: "Product notes." },
  manifest: { advisories: [] },
};
const check = vi.fn();
const fetcher = vi.fn();
let root: Root;
let container: HTMLDivElement;
let useUpdates: () => UseUpdates;
const state: UseUpdates[] = [];
function Harness({ id }: { id: number }) {
  state[id] = useUpdates();
  return null;
}
async function mount() {
  await act(async () =>
    root.render(
      <>
        <Harness id={0} />
        <Harness id={1} />
      </>,
    ),
  );
}
const releaseRequests = () => fetcher.mock.calls.filter(([url]) => String(url).includes("github"));

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset().mockImplementation(async (url) => {
    if (String(url).endsWith("/latest"))
      return new Response(JSON.stringify({ tag_name: "v99.0.0" }));
    if (String(url).endsWith("CHANGELOG.md")) return new Response("## 99.0.0\n\nProduct notes.");
    return new Response(JSON.stringify({ advisories: [] }));
  });
  check.mockReset().mockResolvedValue({ available: false, ...snapshot });
  window.desktop = {
    isDesktop: true,
    app: { version: async () => "0.1.0" },
    config: {
      get: async (key: string) => (key === "lastSeenVersion" ? "0.1.0" : undefined),
      set: async () => true,
    },
    updates: { check },
  } as unknown as DesktopBridge;
  localStorage.clear();
  ({ useUpdates } = await import("./useUpdates"));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete window.desktop;
  vi.unstubAllGlobals();
});

describe("release check requests (#661)", () => {
  it("uses one native snapshot for multiple desktop consumers without a renderer GitHub fetch", async () => {
    await mount();
    expect(check).toHaveBeenCalledOnce();
    expect(releaseRequests()).toHaveLength(0);
    expect(state[0].latest).toEqual(snapshot.latest);
    expect(state[1].latest).toEqual(snapshot.latest);
  });

  it("refreshes through one native check and uses that result", async () => {
    await mount();
    check.mockResolvedValueOnce({
      available: false,
      ...snapshot,
      latest: { ...snapshot.latest, version: "100.0.0" },
    });
    await act(async () => {
      state[0].refresh();
      state[1].refresh();
    });
    expect(check).toHaveBeenCalledTimes(2);
    expect(check).toHaveBeenLastCalledWith(true);
    expect(releaseRequests()).toHaveLength(0);
    expect(state[0].latest?.version).toBe("100.0.0");
  });

  it("also coalesces overlapping manual refreshes in the web dashboard", async () => {
    delete window.desktop;
    await mount();
    expect(releaseRequests()).toHaveLength(3);
    await act(async () => {
      state[0].refresh();
      state[1].refresh();
    });
    expect(releaseRequests()).toHaveLength(6);
  });
});
