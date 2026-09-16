// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { ModalProvider } from "@/context/ModalContext";
import { PlatformProvider } from "@/context/PlatformContext";
import { baseDictionary } from "@/i18n";
import NewServerClusterPage from "@/app/(dashboard)/servers/clusters/new/page";
import {
  clusterCapabilitiesFixture,
  serverClusterFixture,
} from "../../../../../../packages/contracts/test/server-cluster-fixtures";
import { ClusterEditor } from "./ClusterEditor";

const h = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  capabilities: vi.fn(),
  servers: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  verify: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: h.push, replace: h.replace }),
}));
vi.mock("@/lib/api", () => ({
  systemApi: { listServers: h.servers },
  getApiErrorMessage: (error: Error) => error.message,
}));
vi.mock("@/lib/api/server-clusters", () => ({
  serverClustersApi: {
    capabilities: h.capabilities,
    list: h.list,
    get: h.get,
    create: h.create,
    update: h.update,
    verify: h.verify,
  },
}));

let root: Root;
let host: HTMLDivElement;
const c = baseDictionary.servers.clusters;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.capabilities.mockResolvedValue(clusterCapabilitiesFixture());
  h.servers.mockResolvedValue([
    { id: "server-a", name: "Alpha", sshHost: "192.0.2.1" },
    { id: "server-b", name: "Beta", sshHost: "192.0.2.2" },
  ]);
  h.list.mockResolvedValue([]);
  h.get.mockResolvedValue(serverClusterFixture());
  h.create.mockResolvedValue(serverClusterFixture());
  h.update.mockResolvedValue(serverClusterFixture());
  h.verify.mockResolvedValue(null);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render(clusterId?: string, deployMode = "desktop", selfHosted = true) {
  await act(async () => {
    root.render(
      <I18nProvider>
        <PlatformProvider deployMode={deployMode} selfHosted={selfHosted}>
          <ModalProvider>
            {clusterId ? <ClusterEditor clusterId={clusterId} /> : <NewServerClusterPage />}
          </ModalProvider>
        </PlatformProvider>
      </I18nProvider>,
    );
  });
}
async function click(label: string) {
  const button = [...host.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label,
  );
  expect(button, `button ${label}`).toBeDefined();
  await act(async () => button!.click());
}
async function fill(input: HTMLInputElement | null, value: string) {
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("cluster setup pages", () => {
  it.each([undefined, "cluster-a"])("blocks direct Cloud access for clusterId=%s", async (id) => {
    await render(id, "cloud", false);
    expect(host.textContent).toContain(c.selfHostedOnly);
    expect(host.querySelector("input")).toBeNull();
    expect(h.capabilities).not.toHaveBeenCalled();
    expect(h.get).not.toHaveBeenCalled();
    expect(h.servers).not.toHaveBeenCalled();
  });

  it.each([undefined, "cluster-a"])(
    "requires fleet management permission for clusterId=%s",
    async (id) => {
      h.capabilities.mockResolvedValue({ ...clusterCapabilitiesFixture(), canManage: false });
      await render(id);
      expect(host.textContent).toContain(c.managePermissionRequired);
      expect(host.querySelector("input")).toBeNull();
      expect(h.get).not.toHaveBeenCalled();
      expect(h.servers).not.toHaveBeenCalled();
      expect(h.list).not.toHaveBeenCalled();
    },
  );

  it("blocks an edit deep link while network verification is active", async () => {
    const cluster = serverClusterFixture();
    h.get.mockResolvedValue({
      ...cluster,
      verification: {
        revision: cluster.revision,
        status: "running",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    await render(cluster.id);
    expect(host.textContent).toContain(c.editWhileVerifying);
    expect(host.querySelector(`a[href="/servers/clusters/${cluster.id}"]`)).not.toBeNull();
    expect(host.querySelector("input")).toBeNull();
    expect(h.servers).not.toHaveBeenCalled();
  });

  it("recovers a failed capability request without navigating away", async () => {
    h.capabilities.mockRejectedValueOnce(new Error("API is unavailable"));
    await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("API is unavailable");
    await click(c.retry);
    expect(host.querySelector("input")).not.toBeNull();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("preserves the draft between inline steps and saves through the existing create/verify flow", async () => {
    await render();
    expect(host.querySelector("h1")?.textContent).toBe(c.createCluster);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    await fill(host.querySelector(`input[placeholder="${c.namePlaceholder}"]`), "My fleet");
    const members = [...host.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')];
    await act(async () => {
      members[0]!.click();
      members[1]!.click();
    });
    await click(c.continue);
    expect(host.querySelector("h2")?.textContent).toBe(c.stepNetwork);
    expect(document.activeElement).toBe(host.querySelector("h2"));
    await fill(host.querySelector('input[placeholder^="10.20.0.0/24"]'), "10.20.0.0/24");
    const addresses = host.querySelectorAll<HTMLInputElement>('input[placeholder="10.20.0.10"]');
    await fill(addresses[0]!, "10.20.0.2");
    await fill(addresses[1]!, "10.20.0.3");
    await click(c.back);
    expect(
      host.querySelector<HTMLInputElement>(`input[placeholder="${c.namePlaceholder}"]`)?.value,
    ).toBe("My fleet");
    expect(host.querySelectorAll('[role="checkbox"][aria-checked="true"]')).toHaveLength(2);
    await click(c.continue);
    expect(host.querySelector<HTMLInputElement>('input[placeholder^="10.20.0.0/24"]')?.value).toBe(
      "10.20.0.0/24",
    );
    await click(c.continue);
    expect(host.querySelector("h2")?.textContent).toBe(c.stepReview);
    expect(h.create).not.toHaveBeenCalled();
    await click(c.createAndVerify);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "My fleet",
        requestId: expect.any(String),
        network: expect.objectContaining({ cidrs: ["10.20.0.0/24"] }),
        members: [
          expect.objectContaining({ serverId: "server-a", privateIp: "10.20.0.2" }),
          expect.objectContaining({ serverId: "server-b", privateIp: "10.20.0.3" }),
        ],
      }),
    );
    expect(h.verify).toHaveBeenCalledWith(expect.objectContaining({ id: "cluster-a" }));
    expect(h.update).not.toHaveBeenCalled();
    expect(h.replace).toHaveBeenCalledWith("/servers/clusters/cluster-a");
  });

  it("keeps the original revision and draft on edit conflicts, with Cancel returning to the cluster", async () => {
    h.update.mockRejectedValue(new Error("Cluster configuration changed. Reload before editing."));
    await render("cluster-a");
    await fill(host.querySelector(`input[placeholder="${c.namePlaceholder}"]`), "Changed fleet");
    await click(c.continue);
    await click(c.continue);
    await click(c.saveAndVerify);
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({ clusterId: "cluster-a", revision: 1, name: "Changed fleet" }),
    );
    expect(h.create).not.toHaveBeenCalled();
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.replace).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Cluster configuration changed",
    );
    expect(host.textContent).toContain("Changed fleet");
    await click(c.cancel);
    expect(h.push).toHaveBeenCalledWith("/servers/clusters/cluster-a");
  });
});
