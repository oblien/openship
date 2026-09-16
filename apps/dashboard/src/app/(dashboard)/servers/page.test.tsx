// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClusterCapabilities } from "@repo/contracts";
import { I18nProvider } from "@/components/i18n-provider";
import { PlatformProvider } from "@/context/PlatformContext";
import { baseDictionary } from "@/i18n";
import ServersPage from "./page";

const h = vi.hoisted(() => ({
  search: "",
  replace: vi.fn(),
  push: vi.fn(),
  servers: vi.fn(),
  capabilities: vi.fn(),
  clusters: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: h.replace, push: h.push }),
  useSearchParams: () => new URLSearchParams(h.search),
}));
vi.mock("@/lib/api", () => ({
  systemApi: { listServers: h.servers },
  getApiErrorMessage: (error: Error) => error.message,
}));
vi.mock("@/lib/api/server-clusters", () => ({
  serverClustersApi: { capabilities: h.capabilities, list: h.clusters },
}));
// Keep the actual page, platform context, tabs, and cluster overview. Managed
// containers and their mutation modal are unrelated to navigation.
vi.mock("@/hooks/useInfraFleet", () => ({
  useInfraFleet: () => ({ summaries: new Map() }),
}));
vi.mock("@/hooks/useSystemPrepareModal", () => ({
  useContainerApplyModal: () => vi.fn(),
}));

const capabilities: ClusterCapabilities = {
  available: true,
  reason: null,
  canManage: true,
  maxMembers: 16,
  modes: ["native"],
  providers: [],
};
const c = baseDictionary.servers.clusters;
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.search = "";
  h.servers.mockResolvedValue([]);
  h.capabilities.mockResolvedValue(capabilities);
  h.clusters.mockResolvedValue([]);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render(deployMode = "desktop", selfHosted = true) {
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en" initialDictionary={baseDictionary}>
        <PlatformProvider deployMode={deployMode} selfHosted={selfHosted}>
          <ServersPage />
        </PlatformProvider>
      </I18nProvider>,
    );
  });
}
function tab(name: "cluster" | "networking") {
  return host.querySelector<HTMLAnchorElement>(`a[href="/servers?tab=${name}"]`);
}

describe("server cluster navigation", () => {
  it.each(["desktop", "docker"])(
    "opens both infrastructure views from /servers on %s",
    async (mode) => {
      await render(mode);
      expect(tab("cluster")).not.toBeNull();
      expect(tab("networking")).not.toBeNull();
      await act(async () => tab("cluster")!.click());
      expect(h.replace).toHaveBeenLastCalledWith("/servers?tab=cluster");
      h.search = "tab=cluster";
      await render(mode);
      expect(host.querySelector("h2")?.textContent).toBe(c.listTitle);
      expect(host.textContent).toContain(c.createCluster);
      expect(host.textContent).toContain(c.emptyTitle);
      await act(async () => tab("networking")!.click());
      expect(h.replace).toHaveBeenLastCalledWith("/servers?tab=networking");
      h.search = "tab=networking";
      await render(mode);
      expect(host.querySelector("h2")?.textContent).toBe(c.networksTitle);
    },
  );

  it("keeps a deep link selected while capabilities load, fail, and retry", async () => {
    let reject!: (reason: Error) => void;
    h.capabilities.mockImplementationOnce(
      () =>
        new Promise((_, no) => {
          reject = no;
        }),
    );
    h.search = "tab=cluster";
    await render();
    expect(tab("cluster")).not.toBeNull();
    expect(tab("networking")).not.toBeNull();
    expect(host.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe(c.listTitle);
    expect(h.clusters).not.toHaveBeenCalled();

    await act(async () => reject(new Error("Unable to reach the API")));
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Unable to reach the API");
    expect(tab("cluster")).not.toBeNull();
    expect(h.replace).not.toHaveBeenCalled();
    await act(async () => alert!.querySelector("button")!.click());
    expect(h.capabilities).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector("h2")?.textContent).toBe(c.listTitle);
  });

  it("explains unavailable capabilities inside the selected tab", async () => {
    h.search = "tab=networking";
    h.capabilities.mockResolvedValue({
      ...capabilities,
      available: false,
      canManage: false,
      reason: "Fleet access is required",
    });
    await render();
    expect(tab("networking")).not.toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Fleet access is required");
    expect(host.textContent).not.toContain(c.createCluster);
    expect(h.clusters).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps Cloud isolated even with selfHosted=%s", async (selfHosted) => {
    h.search = "tab=cluster";
    await render("cloud", selfHosted);
    expect(tab("cluster")).toBeNull();
    expect(tab("networking")).toBeNull();
    expect(h.capabilities).not.toHaveBeenCalled();
    expect(h.clusters).not.toHaveBeenCalled();
  });
});
