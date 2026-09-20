// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { ModalProvider } from "@/context/ModalContext";
import { PlatformProvider } from "@/context/PlatformContext";
import { baseDictionary } from "@/i18n";
import type { NetworkHostObservation } from "@repo/core";
import NewServerClusterPage from "@/app/(dashboard)/servers/networks/new/page";
import {
  clusterCapabilitiesFixture,
  serverClusterFixture,
} from "../../../../../../packages/contracts/test/server-cluster-fixtures";
import {
  managedOperationFixture,
  managedPreparationFixture,
} from "../../../../../../packages/contracts/test/managed-network-fixtures";
import { NetworkEditor } from "./NetworkEditor";
import { ManagedNetworkOperationPage } from "./ManagedNetworkOperationPage";
import { ManagedNetworkPreparationPage } from "./ManagedNetworkPreparationPage";
import { NetworkDetail } from "./NetworkDetail";

const h = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  search: "",
  capabilities: vi.fn(),
  servers: vi.fn(),
  list: vi.fn(),
  computeList: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  verify: vi.fn(),
  inspect: vi.fn(),
  planManaged: vi.fn(),
  applyManaged: vi.fn(),
  managedOperation: vi.fn(),
  prepareManaged: vi.fn(),
  reviseConnections: vi.fn(),
  managedPreparation: vi.fn(),
  discardPreparation: vi.fn(),
  discardPlan: vi.fn(),
  removePreparationMember: vi.fn(),
  removeOperationMember: vi.fn(),
  remove: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: h.push, replace: h.replace }),
  useSearchParams: () => new URLSearchParams(h.search),
}));
vi.mock("@/lib/api", () => ({
  systemApi: { listServers: h.servers },
  getApiErrorMessage: (error: Error) => error.message,
}));
vi.mock("@/lib/api/compute-clusters", () => ({ computeClustersApi: { list: h.computeList } }));
vi.mock("@/lib/api/private-networks", () => ({
  privateNetworksApi: {
    capabilities: h.capabilities,
    list: h.list,
    get: h.get,
    create: h.create,
    update: h.update,
    verify: h.verify,
    inspect: h.inspect,
    planManaged: h.planManaged,
    applyManaged: h.applyManaged,
    managedOperation: h.managedOperation,
    prepareManaged: h.prepareManaged,
    reviseConnections: h.reviseConnections,
    managedPreparation: h.managedPreparation,
    discardPreparation: h.discardPreparation,
    discardPlan: h.discardPlan,
    removePreparationMember: h.removePreparationMember,
    removeOperationMember: h.removeOperationMember,
    remove: h.remove,
  },
}));

let root: Root;
let host: HTMLDivElement;
const c = baseDictionary.servers.networks;
type ProgressFixture =
  | ReturnType<typeof managedOperationFixture>
  | ReturnType<typeof managedPreparationFixture>;
const streams = new Map<string, (run: ProgressFixture) => void>();
function emitProgress(kind: "operations" | "preparations", run: ProgressFixture) {
  (kind === "operations" ? h.managedOperation : h.managedPreparation).mockResolvedValue(run);
  streams.get(kind)?.(run);
}
beforeEach(() => {
  vi.resetAllMocks();
  h.search = "";
  h.computeList.mockResolvedValue([]);
  streams.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", h.fetch);
  h.fetch.mockImplementation(async (url: string, init: RequestInit) => {
    if (url.endsWith("/networks/stream")) {
      const run = {
        networks: [await h.get()],
        computeClusters: await h.computeList(),
        preparations: [],
      };
      return new Response(
        `event: snapshot\ndata: ${JSON.stringify({ type: "snapshot", run })}\n\nevent: complete\ndata: {"type":"complete"}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }
    const kind = url.includes("/preparations/") ? "preparations" : "operations";
    if (!url.endsWith("/stream")) throw new Error(`Unexpected HTTP request: ${url}`);
    const initial = await (kind === "operations" ? h.managedOperation() : h.managedPreparation());
    let closed = false;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (run: ProgressFixture) => {
          if (closed) return;
          controller.enqueue(
            new TextEncoder().encode(
              `event: snapshot\ndata: ${JSON.stringify({ type: "snapshot", run })}\n\n`,
            ),
          );
          if (
            ![
              "pending",
              "preparing",
              "applying",
              "verifying",
              "committing",
              "rolling_back",
            ].includes(run.status)
          ) {
            controller.enqueue(
              new TextEncoder().encode('event: complete\ndata: {"type":"complete"}\n\n'),
            );
            controller.close();
            closed = true;
          }
        };
        streams.set(kind, write);
        init.signal?.addEventListener(
          "abort",
          () => {
            if (!closed) {
              closed = true;
              controller.error(new DOMException("Aborted", "AbortError"));
            }
          },
          { once: true },
        );
        write(initial);
      },
      cancel() {
        closed = true;
      },
    });
    return new Response(source, { headers: { "Content-Type": "text/event-stream" } });
  });
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
  h.planManaged.mockResolvedValue(managedOperationFixture());
  h.applyManaged.mockImplementation(async () => {
    const result = { ...managedOperationFixture(), sequence: 3, status: "applying" };
    h.managedOperation.mockResolvedValue(result);
    return result;
  });
  h.managedOperation.mockResolvedValue({ ...managedOperationFixture(), status: "applying" });
  h.prepareManaged.mockImplementation(async () => {
    const result = { ...managedPreparationFixture(), sequence: 2 };
    h.managedPreparation.mockResolvedValue(result);
    return result;
  });
  h.managedPreparation.mockResolvedValue(managedPreparationFixture());
  h.reviseConnections.mockImplementation(async (input) => ({
    ...managedPreparationFixture(),
    id: input.requestId,
    input: {
      ...managedPreparationFixture().input,
      requestId: input.requestId,
      access: input.access,
    },
  }));
  h.discardPreparation.mockImplementation(async () => {
    const next = { ...managedPreparationFixture(), sequence: 2, status: "cancelled" };
    h.managedPreparation.mockResolvedValue(next);
    return next;
  });
  h.discardPlan.mockImplementation(async () => {
    const next = { ...managedOperationFixture(), sequence: 2, status: "cancelled" };
    h.managedOperation.mockResolvedValue(next);
    return next;
  });
  h.remove.mockResolvedValue({ removed: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function render(clusterId?: string, deployMode = "desktop", selfHosted = true) {
  const page = clusterId ? (
    <NetworkEditor clusterId={clusterId} />
  ) : (
    await NewServerClusterPage({ searchParams: Promise.resolve({}) })
  );
  await act(async () => {
    root.render(
      <I18nProvider>
        <PlatformProvider deployMode={deployMode} selfHosted={selfHosted}>
          <ModalProvider>{page}</ModalProvider>
        </PlatformProvider>
      </I18nProvider>,
    );
  });
}
async function click(label: string, scope: ParentNode = host) {
  const button = [...scope.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label,
  );
  expect(button, `button ${label}`).toBeDefined();
  await act(async () => button!.click());
}
async function openSetupActions(name: string) {
  const label = c.managed.setupActions.replace("{name}", name);
  const button = [...host.querySelectorAll("button")].find(
    (node) => node.getAttribute("aria-label") === label,
  );
  expect(button, `setup actions for ${name}`).toBeDefined();
  await act(async () => button!.click());
}
async function confirmFirewall(mode: "native" | "wireguard") {
  const text =
    mode === "native"
      ? c.managed.firewallRules.confirmNative
      : c.managed.firewallRules.confirmManaged;
  const checkbox = [...host.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')].find((item) =>
    item.closest("label")?.textContent?.includes(text),
  );
  expect(checkbox).toBeDefined();
  await act(async () => checkbox!.click());
}
function firewallPanel() {
  const headings = [...host.querySelectorAll("h3")].filter(
    (node) => node.textContent === c.managed.firewallRules.title,
  );
  expect(headings).toHaveLength(1);
  return headings[0]!.closest("section")!;
}
async function renderSetup(page: ReactNode) {
  await act(async () =>
    root.render(
      <I18nProvider>
        <PlatformProvider deployMode="desktop" selfHosted>
          {page}
        </PlatformProvider>
      </I18nProvider>,
    ),
  );
}
function confirmation() {
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog).not.toBeNull();
  return dialog!;
}
async function fill(input: HTMLInputElement | null, value: string) {
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const observation = (address: string, name = "eth1"): NetworkHostObservation => ({
  hostIdentity: `host:${address}`,
  interfaces: [
    { name, mtu: 1400, up: true, kind: "vlan", addresses: [{ address, prefixLength: 24 }] },
  ],
});
async function startNetworkStep() {
  await render();
  await fill(host.querySelector(`input[placeholder="${c.namePlaceholder}"]`), "Production");
  await click(c.continue);
  await act(async () => {
    host
      .querySelectorAll<HTMLButtonElement>('[role="checkbox"]')
      .forEach((checkbox) => checkbox.click());
  });
}

async function toggleDirection(source: string, target: string) {
  const checkbox = host.querySelector<HTMLButtonElement>(
    `[role="checkbox"][aria-label="${source} → ${target}"]`,
  );
  expect(checkbox).not.toBeNull();
  await act(async () => checkbox!.click());
}

describe("connection policy editor", () => {
  beforeEach(() =>
    h.capabilities.mockResolvedValue({
      ...clusterCapabilitiesFixture(),
      modes: ["native", "wireguard"],
    }),
  );
  const access = {
    version: 1,
    rules: [{ sourceServerId: "server-a", targetServerId: "server-b" }],
  };
  function readyPreparation() {
    const value = {
      ...managedPreparationFixture(),
      status: "ready" as const,
      operationId: managedOperationFixture().id,
    };
    h.managedPreparation.mockResolvedValue(value);
    return value;
  }
  it("reviews isolated servers without asking the user to open nonexistent transport rules", async () => {
    const operation = managedOperationFixture();
    operation.plan.config.network.access = { version: 1, rules: [] };
    h.managedOperation.mockResolvedValue(operation);
    await renderSetup(<ManagedNetworkOperationPage id={operation.id} />);
    expect(host.textContent).toContain(c.access.noConnections);
    expect(host.textContent).not.toContain(c.managed.firewallRules.confirmManaged);
    expect(host.textContent).not.toContain(c.managed.firewallRules.requiredHint);
    await click(c.managed.apply);
    expect(h.applyManaged).toHaveBeenCalledWith({
      operationId: operation.id,
      planHash: operation.planHash,
      action: "apply",
    });
  });

  it("edits the initial topology and sends only the selected direction when preparing", async () => {
    await startNetworkStep();
    await click(c.access.manage);
    await toggleDirection("Beta", "Alpha");
    expect(h.prepareManaged).not.toHaveBeenCalled();
    await click(c.managed.inspect);
    expect(h.prepareManaged).toHaveBeenCalledWith(
      expect.objectContaining({
        access,
        members: expect.arrayContaining([
          expect.objectContaining({ serverId: "server-a" }),
          expect.objectContaining({ serverId: "server-b" }),
        ]),
      }),
    );
  });

  it("removes and restores a connection without removing either server", async () => {
    await startNetworkStep();
    await click(c.access.manage);
    await click(c.access.remove);
    expect(
      [...host.querySelectorAll('[role="checkbox"][aria-label*="→"]')].every(
        (node) => node.getAttribute("aria-checked") === "false",
      ),
    ).toBe(true);
    expect(host.textContent).toContain(c.access.restore);
    await click(c.access.restore);
    expect(
      [...host.querySelectorAll('[role="checkbox"][aria-label*="→"]')].every(
        (node) => node.getAttribute("aria-checked") === "true",
      ),
    ).toBe(true);
    await click(c.access.remove);
    await click(c.managed.inspect);
    expect(h.prepareManaged.mock.calls[0]![0]).toMatchObject({
      access: { version: 1, rules: [] },
      members: [{ serverId: "server-a" }, { serverId: "server-b" }],
    });
  });

  it("keeps preparation changes in a draft and blocks review until saved or discarded", async () => {
    const value = readyPreparation();
    await renderSetup(<ManagedNetworkPreparationPage id={value.id} />);
    await click(c.access.manage);
    await toggleDirection("server-b", "server-a");
    expect(
      host.querySelector(`a[href="/servers/networks/operations/${value.operationId}"]`),
    ).toBeNull();
    expect(host.textContent).toContain(c.access.unsaved);
    expect(h.reviseConnections).not.toHaveBeenCalled();
    expect(h.prepareManaged).not.toHaveBeenCalled();
    await click(c.access.discard);
    expect(host.textContent).not.toContain(c.access.unsaved);
    expect(
      host.querySelector(`a[href="/servers/networks/operations/${value.operationId}"]`),
    ).not.toBeNull();
    expect(
      host
        .querySelector('[role="checkbox"][aria-label="server-b → server-a"]')
        ?.getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("saves one immutable revision and holds the lock until navigation", async () => {
    const value = readyPreparation();
    let finish!: () => void;
    h.reviseConnections.mockImplementation(
      (input) =>
        new Promise((resolve) => {
          finish = () => resolve({ ...value, id: input.requestId });
        }),
    );
    await renderSetup(<ManagedNetworkPreparationPage id={value.id} />);
    await click(c.access.manage);
    await toggleDirection("server-b", "server-a");
    const save = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === c.access.save,
    )!;
    await act(async () => {
      save.click();
      save.click();
    });
    expect(h.reviseConnections).toHaveBeenCalledOnce();
    expect(h.reviseConnections).toHaveBeenCalledWith({
      preparationId: value.id,
      sequence: value.sequence,
      requestId: expect.any(String),
      access,
    });
    expect(save.disabled).toBe(true);
    await act(async () => finish());
    expect(h.push).toHaveBeenCalledWith(
      `/servers/networks/preparations/${h.reviseConnections.mock.calls[0]![0].requestId}`,
    );
    expect(save.disabled).toBe(true);
    await act(async () => save.click());
    expect(h.reviseConnections).toHaveBeenCalledOnce();
  });

  it("reattaches to a saved revision after the response is lost", async () => {
    const value = readyPreparation();
    h.reviseConnections.mockImplementation(async (input) => {
      h.managedPreparation.mockImplementation(async (id) =>
        id === input.requestId
          ? { ...value, id, input: { ...value.input, requestId: id, access: input.access } }
          : value,
      );
      throw new Error("Connection lost");
    });
    await renderSetup(<ManagedNetworkPreparationPage id={value.id} />);
    await click(c.access.manage);
    await toggleDirection("server-b", "server-a");
    await click(c.access.save);
    expect(h.reviseConnections).toHaveBeenCalledOnce();
    expect(h.push).toHaveBeenCalledWith(
      `/servers/networks/preparations/${h.reviseConnections.mock.calls[0]![0].requestId}`,
    );
    expect(host.textContent).not.toContain("Connection lost");
  });

  it("allows designing during inspection but waits for the current attempt before saving", async () => {
    const value = managedPreparationFixture();
    await renderSetup(<ManagedNetworkPreparationPage id={value.id} />);
    await click(c.access.manage);
    await toggleDirection("server-b", "server-a");
    const save = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === c.access.save,
    )!;
    expect(save.disabled).toBe(true);
    expect(host.textContent).toContain(c.access.preparingHint);
    await act(async () =>
      emitProgress("preparations", {
        ...value,
        status: "ready",
        sequence: 2,
        operationId: managedOperationFixture().id,
      }),
    );
    expect(save.disabled).toBe(false);
    await act(async () => save.click());
    expect(h.reviseConnections).toHaveBeenCalledWith(
      expect.objectContaining({ sequence: 2, access }),
    );
  });
});

describe("cluster setup pages", () => {
  it("chooses a native provider and network once before configuring its servers", async () => {
    h.capabilities.mockResolvedValue({
      ...clusterCapabilitiesFixture(),
      modes: ["native", "wireguard"],
    });
    h.inspect.mockImplementation(async (id: string) =>
      observation(id === "server-a" ? "10.20.0.2" : "10.20.0.3"),
    );
    await render();
    expect(host.querySelector<HTMLInputElement>('input[value="wireguard"]')?.checked).toBe(true);
    expect(host.querySelector(`button[aria-label="${c.provider}"]`)).toBeNull();
    expect(host.querySelector('[role="checkbox"]')).toBeNull();
    await act(async () => host.querySelector<HTMLInputElement>('input[value="native"]')!.click());
    const provider = host.querySelector<HTMLButtonElement>(`button[aria-label="${c.provider}"]`)!;
    await act(async () => provider.click());
    const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (node) => node.textContent?.includes("Hetzner Dedicated"),
    );
    expect(option).toBeDefined();
    await act(async () => option!.click());
    await fill(host.querySelector('input[placeholder="Robot vSwitch"]'), "vswitch-production");
    await fill(host.querySelector(`input[placeholder="${c.namePlaceholder}"]`), "Private fleet");
    expect(host.textContent).toContain(c.networkSetup.providerHint);
    await click(c.continue);
    await act(async () =>
      host
        .querySelectorAll<HTMLButtonElement>('[role="checkbox"]')
        .forEach((button) => button.click()),
    );
    expect(host.querySelector(`button[aria-label="${c.provider}"]`)).toBeNull();
    expect(host.querySelector('input[placeholder="Robot vSwitch"]')).toBeNull();
    await click(c.detectNetworkSettings);
    await click(c.continue);
    expect(host.textContent).toContain("vswitch-production");
    expect(host.textContent).toContain("Hetzner Dedicated");
    await confirmFirewall("native");
    await click(c.createAndVerify);
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({
        network: expect.objectContaining({
          source: { providerId: "hetzner-dedicated", networkRef: "vswitch-production" },
        }),
        members: expect.arrayContaining([
          expect.objectContaining({ serverId: "server-b", providerId: "custom" }),
        ]),
      }),
    );
  });
  it("retains the network overview as the parent when opening a group or switching detail tabs", async () => {
    h.search = "tab=network&from=networking";
    await renderSetup(<NetworkDetail id="cluster-a" />);
    const back = host.querySelector<HTMLAnchorElement>('a[href="/servers?tab=networking"]');
    expect(back?.textContent).toContain(c.networkGroups.back);
    const members = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === c.members,
    );
    expect(members).toBeDefined();
    await act(async () => members!.click());
    expect(h.replace).toHaveBeenLastCalledWith("/servers/networks/cluster-a?tab=members");
  });
  it("starts a speed test only after an explicit click and sends the selected server pair", async () => {
    const cluster = serverClusterFixture();
    h.get.mockResolvedValue(cluster);
    await renderSetup(<NetworkDetail id={cluster.id} />);
    expect(h.verify).not.toHaveBeenCalled();
    expect(host.textContent).toContain(c.diagnostics.title);
    expect(host.textContent).toContain("32 MiB");
    await click(c.diagnostics.testSpeed);
    expect(h.verify).toHaveBeenCalledWith(cluster, {
      sourceServerId: "server-a",
      targetServerId: "server-b",
    });
  });
  it("keeps network measurements readable without offering speed mutations to a viewer", async () => {
    h.capabilities.mockResolvedValue({ ...clusterCapabilitiesFixture(), canManage: false });
    await renderSetup(<NetworkDetail id={serverClusterFixture().id} />);
    expect(host.textContent).toContain(c.diagnostics.title);
    expect(host.textContent).not.toContain(c.diagnostics.testSpeed);
    expect(h.verify).not.toHaveBeenCalled();
  });
  it("removes a selected failed server with confirmation and reuses its request after a lost response", async () => {
    // Plain HTTP/LAN dashboards have crypto but no secure-context randomUUID.
    vi.stubGlobal("crypto", {});
    const failed = {
      ...managedPreparationFixture(["server-a", "server-b", "server-c"]),
      status: "failed" as const,
      sequence: 5,
    };
    const updated = {
      ...managedPreparationFixture(),
      id: "new-setup",
      status: "preparing" as const,
    };
    h.managedPreparation.mockResolvedValue(failed);
    h.removePreparationMember
      .mockRejectedValueOnce(new Error("Response lost"))
      .mockResolvedValue({ preparation: updated, operation: null });
    await renderSetup(<ManagedNetworkPreparationPage id={failed.id} />);
    const server = host.querySelector('section[aria-label="server-c"]')!;
    await click(c.managed.removeFromSetup, server);
    expect(confirmation().textContent).toContain("server-c");
    expect(confirmation().textContent).toContain("remaining 2 servers");
    expect(h.removePreparationMember).not.toHaveBeenCalled();
    await click(c.cancel, confirmation());
    await click(c.managed.removeFromSetup, server);
    await click(c.managed.removeFromSetup, confirmation());
    expect(confirmation().textContent).toContain("Response lost");
    const request = h.removePreparationMember.mock.calls[0]![0];
    expect(request).toMatchObject({
      preparationId: failed.id,
      serverId: "server-c",
      sequence: 5,
      requestId: expect.any(String),
    });
    await click(c.managed.removeFromSetup, confirmation());
    expect(h.removePreparationMember.mock.calls[1]![0]).toEqual(request);
    expect(h.push).toHaveBeenCalledWith("/servers/networks/preparations/new-setup");
    expect(h.applyManaged).not.toHaveBeenCalled();
    expect(h.prepareManaged).not.toHaveBeenCalled();
  });

  it("explains the two-server minimum and hides per-server removal for established clusters", async () => {
    const failed = { ...managedPreparationFixture(), status: "failed" as const };
    h.managedPreparation.mockResolvedValue(failed);
    await renderSetup(<ManagedNetworkPreparationPage id={failed.id} />);
    const buttons = [...host.querySelectorAll("button")].filter(
      (button) => button.textContent?.trim() === c.managed.removeFromSetup,
    );
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(host.textContent).toContain(c.managed.keepTwoServers);
    h.managedPreparation.mockResolvedValue({
      ...failed,
      id: "edit-setup",
      input: { ...failed.input, clusterId: "existing", revision: 2 },
    });
    await renderSetup(<ManagedNetworkPreparationPage id="edit-setup" />);
    expect(host.textContent).not.toContain(c.managed.removeFromSetup);
  });

  it.each([false, true])(
    "offers reset-and-remove for an applied setup, with step progress: %s",
    async (steps) => {
      const failed = {
        ...managedOperationFixture(["server-a", "server-b", "server-c"]),
        status: "needs_attention" as const,
        sequence: 8,
      };
      if (steps)
        failed.hosts = failed.hosts.map((host) => ({
          ...host,
          steps: [
            {
              id: "configure",
              status: "failed",
              message: "Route failed",
              startedAt: null,
              finishedAt: null,
            },
          ],
        }));
      h.managedOperation.mockResolvedValue(failed);
      h.removeOperationMember.mockResolvedValue({
        preparation: { ...managedPreparationFixture(), id: "updated-setup", status: "pending" },
        operation: failed,
      });
      await renderSetup(<ManagedNetworkOperationPage id={failed.id} />);
      await click(c.managed.removeFromSetup);
      expect(confirmation().textContent).toContain("network changes");
      expect(confirmation().textContent).toContain("Every server must acknowledge cleanup");
      await click(c.managed.removeAndReset, confirmation());
      expect(h.removeOperationMember).toHaveBeenCalledWith({
        operationId: failed.id,
        serverId: "server-a",
        sequence: 8,
        planHash: failed.planHash,
        requestId: expect.any(String),
      });
      expect(h.push).toHaveBeenCalledWith("/servers/networks/preparations/updated-setup");
      expect(h.applyManaged).not.toHaveBeenCalled();
    },
  );

  it("recovers the updated setup link from SSE when a removal response is lost", async () => {
    const failed = {
      ...managedOperationFixture(["server-a", "server-b", "server-c"]),
      status: "needs_attention" as const,
    };
    h.managedOperation.mockResolvedValue(failed);
    h.removeOperationMember.mockImplementation(async () => {
      h.managedOperation.mockResolvedValue({
        ...failed,
        sequence: 2,
        replacementPreparationId: "replacement",
      });
      throw new Error("Connection lost");
    });
    await renderSetup(<ManagedNetworkOperationPage id={failed.id} />);
    await click(c.managed.removeFromSetup);
    await click(c.managed.removeAndReset, confirmation());
    expect(
      host.querySelector('a[href="/servers/networks/preparations/replacement"]')?.textContent,
    ).toContain(c.managed.viewUpdatedSetup);
    expect(host.textContent).not.toContain(c.managed.removeFromSetup);
    expect(
      [...host.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === c.managed.resume,
      ),
    ).toBe(false);
    expect(h.push).not.toHaveBeenCalled();
  });

  it("leaves a saved selection paused through reload and stream updates until Retry is pressed", async () => {
    const preparation = {
      ...managedPreparationFixture(["server-a", "server-b", "server-c"]),
      status: "pending" as const,
    };
    h.managedPreparation.mockResolvedValue(preparation);
    h.prepareManaged.mockResolvedValue({ ...preparation, status: "preparing", sequence: 2 });
    await renderSetup(<ManagedNetworkPreparationPage id={preparation.id} />);
    await act(async () => emitProgress("preparations", preparation));
    await renderSetup(<ManagedNetworkPreparationPage key="reloaded" id={preparation.id} />);
    expect(h.prepareManaged).not.toHaveBeenCalled();
    expect(h.applyManaged).not.toHaveBeenCalled();
    expect(host.textContent).toContain(c.managed.selectionSavedHint);
    expect(host.querySelector('[role="status"] .animate-spin')).toBeNull();
    expect(host.textContent).toContain(c.managed.removeFromSetup);
    await openSetupActions(preparation.input.name);
    expect(host.textContent).toContain(c.managed.discardSetup);
    await openSetupActions(preparation.input.name);
    await click(c.managed.retryPreparation);
    expect(h.prepareManaged).toHaveBeenCalledExactlyOnceWith(preparation.input);
  });

  it("streams cleanup for the removed server and continues only after rollback is confirmed", async () => {
    const operation = {
      ...managedOperationFixture(["server-a", "server-b", "server-c"]),
      status: "needs_attention" as const,
      replacementPreparationId: "remaining-setup",
      error: "Server C unreachable",
    };
    const preparation = {
      ...managedPreparationFixture(),
      id: "remaining-setup",
      input: { ...managedPreparationFixture().input, requestId: "remaining-setup" },
      status: "pending" as const,
      cleanupOperationId: operation.id,
    };
    h.managedPreparation.mockResolvedValue(preparation);
    h.managedOperation.mockResolvedValue(operation);
    h.applyManaged.mockImplementation(async () => {
      const next = { ...operation, status: "rolled_back", sequence: 2, error: null };
      h.managedOperation.mockResolvedValue(next);
      return next;
    });
    h.prepareManaged.mockImplementation(async () => {
      const next = { ...preparation, status: "preparing", sequence: 2 };
      h.managedPreparation.mockResolvedValue(next);
      return next;
    });
    await renderSetup(<ManagedNetworkPreparationPage id={preparation.id} />);
    expect(host.textContent).toContain(c.managed.resetBeforeContinue);
    expect(host.textContent).toContain("Server C unreachable");
    expect(host.querySelector('section[aria-label="server-c"]')).not.toBeNull();
    expect(
      [...host.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === c.managed.retryPreparation,
      ),
    ).toBe(false);
    expect(host.textContent).not.toContain(c.managed.editSettings);
    await click(c.managed.retryCleanup);
    expect(h.applyManaged).toHaveBeenCalledWith({
      operationId: operation.id,
      planHash: operation.planHash,
      action: "rollback",
    });
    expect(h.prepareManaged).not.toHaveBeenCalled();
    await click(c.managed.retryPreparation);
    expect(h.prepareManaged).toHaveBeenCalledWith(preparation.input);
    expect(host.querySelector('section[aria-label="server-c"]')).toBeNull();
    await act(async () =>
      emitProgress("preparations", {
        ...preparation,
        status: "ready",
        sequence: 3,
        operationId: "new-plan",
      }),
    );
    expect(
      host.querySelector('a[href="/servers/networks/operations/new-plan"]')?.textContent,
    ).toContain(c.managed.reviewNetwork);
    expect(h.applyManaged).toHaveBeenCalledTimes(1);
  });

  it.each(["ready", "failed", "interrupted", "pending"])(
    "discards a %s preparation from its menu without running host work",
    async (status) => {
      const preparation = {
        ...managedPreparationFixture(),
        status,
        operationId: status === "ready" ? managedOperationFixture().id : null,
      };
      h.managedPreparation.mockResolvedValue(preparation);
      await renderSetup(<ManagedNetworkPreparationPage id={preparation.id} />);
      await openSetupActions(preparation.input.name);
      await click(c.managed.discardSetup);
      expect(confirmation().textContent).toContain(c.managed.discardDescription);
      expect(confirmation().textContent).toContain(preparation.input.name);
      expect(h.discardPreparation).not.toHaveBeenCalled();
      await click(c.cancel, confirmation());
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      await openSetupActions(preparation.input.name);
      await click(c.managed.discardSetup);
      await click(c.managed.discardSetup, confirmation());
      expect(h.discardPreparation).toHaveBeenCalledExactlyOnceWith({
        preparationId: preparation.id,
        sequence: preparation.sequence,
      });
      expect(h.replace).toHaveBeenCalledWith("/servers?tab=networking");
      expect(h.prepareManaged).not.toHaveBeenCalled();
      expect(h.applyManaged).not.toHaveBeenCalled();
      expect(host.textContent).toContain(c.managed.setupDiscardedHint);
      expect(host.textContent).not.toContain(c.managed.retryPreparation);
    },
  );

  it("keeps a failed discard actionable and reattaches to saved progress", async () => {
    const failed = { ...managedPreparationFixture(), status: "interrupted" };
    h.managedPreparation.mockResolvedValue(failed);
    h.discardPreparation.mockRejectedValueOnce(
      new Error("Preparation changed. Reload its saved progress."),
    );
    await renderSetup(<ManagedNetworkPreparationPage id={failed.id} />);
    await openSetupActions(failed.input.name);
    await click(c.managed.discardSetup);
    await click(c.managed.discardSetup, confirmation());
    expect(confirmation().querySelector('[role="alert"]')?.textContent).toContain(
      "Preparation changed",
    );
    expect(h.replace).not.toHaveBeenCalled();
    expect(h.fetch).toHaveBeenCalledTimes(2);
    await click(c.managed.discardSetup, confirmation());
    expect(h.discardPreparation.mock.calls[1]![0]).toEqual(h.discardPreparation.mock.calls[0]![0]);
    expect(h.replace).toHaveBeenCalledWith("/servers?tab=networking");
  });

  it.each(["preparing", "cancelled", "read-only", "pending cleanup", "replaced"])(
    "does not offer discard for %s preparation",
    async (state) => {
      const preparation = {
        ...managedPreparationFixture(),
        status:
          state === "read-only" || state === "replaced"
            ? "ready"
            : state === "pending cleanup"
              ? "pending"
              : state,
        cleanupOperationId: state === "pending cleanup" ? managedOperationFixture().id : null,
        replacementPreparationId: state === "replaced" ? "replacement-setup" : null,
      };
      if (state === "read-only")
        h.capabilities.mockResolvedValue({ ...clusterCapabilitiesFixture(), canManage: false });
      h.managedPreparation.mockResolvedValue(preparation);
      await renderSetup(<ManagedNetworkPreparationPage id={preparation.id} />);
      expect(
        [...host.querySelectorAll("button")].some(
          (button) =>
            button.getAttribute("aria-label") ===
            c.managed.setupActions.replace("{name}", preparation.input.name),
        ),
      ).toBe(false);
      expect(h.discardPreparation).not.toHaveBeenCalled();
    },
  );

  it("discards the reviewed plan through its guarded endpoint instead of only navigating away", async () => {
    const operation = managedOperationFixture();
    h.managedOperation.mockResolvedValue(operation);
    await renderSetup(<ManagedNetworkOperationPage id={operation.id} />);
    await click(c.managed.discardPlan);
    expect(h.discardPlan).not.toHaveBeenCalled();
    await click(c.managed.discardPlan, confirmation());
    expect(h.discardPlan).toHaveBeenCalledExactlyOnceWith({
      operationId: operation.id,
      planHash: operation.planHash,
    });
    expect(h.replace).toHaveBeenCalledWith("/servers?tab=networking");
    expect(h.applyManaged).not.toHaveBeenCalled();
    expect(host.textContent).toContain(c.managed.status.cancelled);
  });

  it("keeps preparation focused on tools and shows resolved firewall rules once in final review", async () => {
    const preparation = managedPreparationFixture();
    preparation.input.clusterId = "existing-cluster";
    preparation.input.revision = 1;
    for (const member of preparation.input.members) {
      delete member.endpoint;
      delete member.listenPort;
    }
    h.managedPreparation.mockResolvedValue(preparation);
    await renderSetup(<ManagedNetworkPreparationPage id={preparation.id} />);
    expect(host.textContent).not.toContain(c.managed.firewallRules.title);
    expect(host.querySelector('[role="checkbox"]')).toBeNull();
    const next = structuredClone(preparation);
    next.sequence++;
    next.hosts[0]!.transport = { endpoint: "203.0.113.51", listenPort: 53051 };
    next.hosts[1]!.transport = { endpoint: "203.0.113.52", listenPort: 53052 };
    await act(async () => emitProgress("preparations", next));
    expect(host.textContent).not.toContain(c.managed.firewallRules.title);
    expect(h.managedPreparation).toHaveBeenCalledTimes(1);
    expect(h.prepareManaged).not.toHaveBeenCalled();
    const operation = managedOperationFixture();
    operation.status = "planned";
    for (const [index, planned] of operation.plan.hosts.entries()) {
      Object.assign(planned, next.hosts[index]!.transport);
      Object.assign(operation.plan.config.members[index]!, next.hosts[index]!.transport);
    }
    h.managedOperation.mockResolvedValue(operation);
    await renderSetup(<ManagedNetworkOperationPage id={operation.id} />);
    const rules = firewallPanel();
    expect(rules.textContent).toContain("203.0.113.51/32");
    expect(rules.textContent).toContain("203.0.113.52/32");
    expect(rules.textContent).toContain("53051");
    expect(rules.textContent).toContain("53052");
    expect(rules.textContent).not.toContain("51820");
    expect(rules.querySelectorAll("h4")).toHaveLength(2);
    expect(rules.querySelectorAll('[role="checkbox"]')).toHaveLength(1);
    expect(host.querySelector('aside [role="checkbox"]')).toBeNull();
    expect(h.applyManaged).not.toHaveBeenCalled();
  });

  it("includes every selected peer in firewall guidance for an asymmetric handshake failure", async () => {
    const operation = managedOperationFixture(["server-a", "server-b", "server-c"]);
    operation.status = "needs_attention";
    operation.report = {
      stage: "handshakes",
      hosts: [],
      peers: [],
      handshakes: [
        {
          sourceServerId: "server-a",
          targetServerId: "server-b",
          endpoint: "192.0.2.11",
          port: 51820,
          ok: false,
          lastHandshakeAt: null,
        },
      ],
    };
    h.managedOperation.mockResolvedValue(operation);
    await renderSetup(<ManagedNetworkOperationPage id={operation.id} />);
    expect(host.textContent).toContain(c.managed.transportFailedTitle);
    const rules = firewallPanel();
    expect(rules.querySelectorAll("h4")).toHaveLength(3);
    const server = [...rules.querySelectorAll("h4")]
      .find((node) => node.textContent === "server-b")!
      .closest("section")!;
    const incoming = [...server.querySelectorAll("h5")]
      .find((node) => node.textContent === c.managed.firewallRules.inbound)!
      .closest("section")!;
    expect(incoming.textContent).toContain("192.0.2.10/32");
    expect(incoming.textContent).toContain("192.0.2.12/32");
    expect(incoming.querySelectorAll("li")).toHaveLength(2);
    expect(rules.querySelectorAll('[role="checkbox"]')).toHaveLength(1);
    expect(h.applyManaged).not.toHaveBeenCalled();
  });

  it("requires firewall confirmation before apply and again after an interrupted attempt", async () => {
    const operation = managedOperationFixture();
    operation.status = "planned";
    h.managedOperation.mockResolvedValue(operation);
    await renderSetup(<ManagedNetworkOperationPage id={operation.id} />);
    await click(c.managed.apply);
    expect(h.applyManaged).not.toHaveBeenCalled();
    await confirmFirewall("wireguard");
    await click(c.managed.apply);
    expect(h.applyManaged).toHaveBeenCalledExactlyOnceWith({
      operationId: operation.id,
      planHash: operation.planHash,
      action: "apply",
    });
    await act(async () =>
      emitProgress("operations", {
        ...operation,
        sequence: 4,
        generation: 1,
        status: "interrupted",
      }),
    );
    expect(host.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("false");
    await click(c.managed.resume);
    expect(h.applyManaged).toHaveBeenCalledTimes(1);
    await confirmFirewall("wireguard");
    await click(c.managed.resume);
    expect(h.applyManaged).toHaveBeenCalledTimes(2);
  });

  it("does not require firewall confirmation to remove an existing managed network", async () => {
    const operation = managedOperationFixture();
    operation.status = "planned";
    operation.plan.intent = "remove";
    h.managedOperation.mockResolvedValue(operation);
    await renderSetup(<ManagedNetworkOperationPage id={operation.id} />);
    expect(host.querySelector('[role="checkbox"]')).toBeNull();
    await click(c.managed.removalApply);
    expect(h.applyManaged).toHaveBeenCalledExactlyOnceWith({
      operationId: operation.id,
      planHash: operation.planHash,
      action: "apply",
    });
  });

  it("cleans a failed initial network through rollback and only offers Close after cleanup settles", async () => {
    const operation = { ...managedOperationFixture(), status: "needs_attention" };
    h.managedOperation.mockResolvedValue(operation);
    h.applyManaged.mockImplementationOnce(async () => {
      const next = { ...operation, sequence: 2, status: "rolling_back" };
      h.managedOperation.mockResolvedValue(next);
      return next;
    });
    await renderSetup(<ManagedNetworkOperationPage id={operation.id} />);
    await click(c.managed.cleanupSetup);
    expect(confirmation().textContent).toContain(c.managed.cleanupDescription);
    expect(h.applyManaged).not.toHaveBeenCalled();
    await click(c.managed.cleanupSetup, confirmation());
    expect(h.applyManaged).toHaveBeenCalledExactlyOnceWith({
      operationId: operation.id,
      planHash: operation.planHash,
      action: "rollback",
    });
    expect(host.textContent).toContain(c.managed.status.rolling_back);
    expect(host.textContent).not.toContain(c.managed.closeSetup);
    expect(h.discardPlan).not.toHaveBeenCalled();
    await act(async () =>
      emitProgress("operations", {
        ...managedOperationFixture(),
        sequence: 3,
        status: "rolled_back",
      }),
    );
    expect(host.textContent).toContain(c.managed.setupCleanedHint);
    expect(
      [...host.querySelectorAll("a")]
        .find((link) => link.textContent?.trim() === c.managed.closeSetup)
        ?.getAttribute("href"),
    ).toBe("/servers?tab=networking");
  });

  it("explains that restoring a failed change preserves an existing cluster", async () => {
    const operation = { ...managedOperationFixture(), status: "interrupted" };
    operation.plan.baseRevision = 1;
    operation.plan.previous = operation.plan.config;
    h.managedOperation.mockResolvedValue(operation);
    await renderSetup(<ManagedNetworkOperationPage id={operation.id} />);
    expect(host.textContent).not.toContain(c.managed.cleanupSetup);
    await click(c.managed.restore);
    expect(confirmation().textContent).toContain(c.managed.restoreDescription);
    expect(h.applyManaged).not.toHaveBeenCalled();
  });

  it("exposes cleanup on the failed cluster page without bypassing the recovery operation", async () => {
    const operation = { ...managedOperationFixture(), status: "needs_attention" };
    h.get.mockResolvedValue({
      ...serverClusterFixture(),
      id: operation.clusterId,
      verification: null,
      operation,
      network: {
        ...operation.plan.config.network,
        id: "network",
        ownership: "openship",
        encryption: "wireguard",
      },
    });
    await renderSetup(<NetworkDetail id={operation.clusterId} />);
    await click(c.managed.cleanupSetup);
    expect(h.push).toHaveBeenCalledWith(`/servers/networks/operations/${operation.id}`);
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.planManaged).not.toHaveBeenCalled();
    expect(h.applyManaged).not.toHaveBeenCalled();
  });

  it("reuses a removal request after a failed plan response and keeps network removal reviewable", async () => {
    const operation = managedOperationFixture();
    h.get.mockResolvedValue({
      ...serverClusterFixture(),
      id: operation.clusterId,
      operation: null,
      verification: null,
      network: {
        ...operation.plan.config.network,
        id: "network",
        ownership: "openship",
        encryption: "wireguard",
      },
    });
    h.planManaged.mockRejectedValueOnce(new Error("Plan response lost"));
    await renderSetup(<NetworkDetail id={operation.clusterId} />);
    await click(c.removeCluster);
    expect(h.planManaged).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "remove", clusterId: operation.clusterId }),
    );
    expect(h.applyManaged).not.toHaveBeenCalled();
    await click(c.removeCluster);
    expect(h.planManaged.mock.calls[1]![0].requestId).toBe(
      h.planManaged.mock.calls[0]![0].requestId,
    );
    expect(h.push).toHaveBeenCalledWith(`/servers/networks/operations/${operation.id}`);
    expect(h.remove).not.toHaveBeenCalled();
  });

  it("shows a restarted preparation as stopped and retries only after an explicit click", async () => {
    const preparation = managedPreparationFixture();
    preparation.hosts[0]!.steps[0]!.status = "completed";
    preparation.hosts[0]!.steps[1]!.status = "running";
    preparation.hosts[0]!.steps[1]!.message = "Checking required tools";
    h.managedPreparation.mockResolvedValue(preparation);
    await renderSetup(<ManagedNetworkPreparationPage id={preparation.id} />);
    await act(async () =>
      emitProgress("preparations", {
        ...preparation,
        status: "interrupted",
        sequence: preparation.sequence + 1,
        leaseExpiresAt: null,
        error: "OpenShip restarted before server preparation finished.",
      }),
    );
    expect(host.textContent).toContain(c.managed.preparationStatus.interrupted);
    expect(host.textContent).toContain("OpenShip restarted before server preparation finished.");
    expect(host.textContent).toContain(c.managed.stepStatus.interrupted);
    const server = host.querySelector('section[aria-label="server-a"]')!;
    await act(async () =>
      server.querySelector<HTMLButtonElement>("button[aria-expanded]")!.click(),
    );
    expect(server.querySelector(".animate-spin")).toBeNull();
    expect(server.textContent).toContain(c.managed.stepStatus.completed);
    expect(server.textContent).toContain(c.managed.stepStatus.interrupted);
    expect(h.prepareManaged).not.toHaveBeenCalled();
    expect(h.applyManaged).not.toHaveBeenCalled();
    await click(c.managed.retryPreparation);
    expect(h.prepareManaged).toHaveBeenCalledOnce();
    expect(h.prepareManaged).toHaveBeenCalledWith(preparation.input);
  });
  it("streams durable progress without polling and exposes recovery when the controller is interrupted", async () => {
    vi.useFakeTimers();
    await act(async () =>
      root.render(
        <I18nProvider>
          <PlatformProvider deployMode="desktop" selfHosted>
            <ManagedNetworkOperationPage id={managedOperationFixture().id} />
          </PlatformProvider>
        </I18nProvider>,
      ),
    );
    expect(host.textContent).toContain(c.managed.status.applying);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(h.fetch).toHaveBeenCalledOnce();
    await act(async () =>
      emitProgress("operations", {
        ...managedOperationFixture(),
        sequence: 2,
        status: "interrupted",
      }),
    );
    expect(host.textContent).toContain(c.managed.resume);
    expect(host.textContent).toContain(c.managed.cleanupSetup);
    expect(h.applyManaged).not.toHaveBeenCalled();
    await confirmFirewall("wireguard");
    await click(c.managed.resume);
    expect(h.applyManaged).toHaveBeenCalledWith({
      operationId: managedOperationFixture().id,
      planHash: managedOperationFixture().planHash,
      action: "resume",
    });
    await act(async () =>
      emitProgress("operations", {
        ...managedOperationFixture(),
        sequence: 4,
        status: "succeeded",
      }),
    );
    expect(host.textContent).toContain(c.managed.status.succeeded);
    expect(
      host.querySelector(`a[href="/servers/networks/${managedOperationFixture().clusterId}"]`),
    ).not.toBeNull();
  });
  it("starts durable prerequisite preparation before inspecting or applying a network", async () => {
    h.capabilities.mockResolvedValue({
      ...clusterCapabilitiesFixture(),
      modes: ["native", "wireguard"],
    });
    await startNetworkStep();
    expect(host.querySelector(`button[aria-label="${c.provider}"]`)).toBeNull();
    expect(host.textContent).toContain(c.managed.requirements);
    expect(host.querySelector(`input[placeholder="${c.privateAddress}"]`)).toBeNull();
    await click(c.managed.inspect);
    expect(h.prepareManaged).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Production",
        cidr: undefined,
        members: [
          expect.objectContaining({ serverId: "server-a", endpoint: undefined, listenPort: 51820 }),
          expect.objectContaining({ serverId: "server-b", endpoint: undefined, listenPort: 51820 }),
        ],
      }),
    );
    expect(h.push).toHaveBeenCalledWith(
      `/servers/networks/preparations/${managedPreparationFixture().id}`,
    );
    expect(h.planManaged).not.toHaveBeenCalled();
    expect(h.applyManaged).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.verify).not.toHaveBeenCalled();
  });
  it("locks preparation from the first click until the destination replaces the wizard", async () => {
    h.capabilities.mockResolvedValue({
      ...clusterCapabilitiesFixture(),
      modes: ["native", "wireguard"],
    });
    let finishPreparation!: () => void;
    h.prepareManaged.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPreparation = () => resolve(managedPreparationFixture());
        }),
    );
    await startNetworkStep();
    const prepare = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === c.managed.inspect,
    )!;

    await act(async () => {
      prepare.click();
      prepare.click();
    });
    expect(h.prepareManaged).toHaveBeenCalledOnce();
    expect(h.push).not.toHaveBeenCalled();
    expect(prepare.disabled).toBe(true);
    expect(prepare.textContent).toBe(c.managed.inspecting);
    expect(prepare.querySelector(".animate-spin")).not.toBeNull();
    expect([...host.querySelectorAll("fieldset")].every((fieldset) => fieldset.disabled)).toBe(
      true,
    );

    await act(async () => finishPreparation());
    expect(h.push).toHaveBeenCalledExactlyOnceWith(
      `/servers/networks/preparations/${managedPreparationFixture().id}`,
    );
    // The router has accepted navigation, but the current page is still mounted.
    expect(prepare.disabled).toBe(true);
    expect(prepare.getAttribute("aria-busy")).toBe("true");
    expect(prepare.textContent).toBe(c.managed.inspecting);
    expect(prepare.querySelector(".animate-spin")).not.toBeNull();
    expect([...host.querySelectorAll("fieldset")].every((fieldset) => fieldset.disabled)).toBe(
      true,
    );
    for (const label of [c.back, c.backToClusters, c.cancel]) {
      const button = [...host.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === label,
      );
      expect(button?.disabled).toBe(true);
    }
    await act(async () => prepare.click());
    expect(h.prepareManaged).toHaveBeenCalledOnce();
    expect(h.push).toHaveBeenCalledOnce();
  });
  it("keeps the draft actionable when preparation cannot start", async () => {
    h.capabilities.mockResolvedValue({
      ...clusterCapabilitiesFixture(),
      modes: ["native", "wireguard"],
    });
    h.prepareManaged.mockRejectedValueOnce(
      new Error("A selected server belongs to another cluster"),
    );
    await startNetworkStep();
    await click(c.managed.inspect);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("another cluster");
    expect(h.applyManaged).not.toHaveBeenCalled();
    const prepare = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === c.managed.inspect,
    )!;
    expect(prepare.disabled).toBe(false);
    expect(prepare.getAttribute("aria-busy")).toBe("false");
    expect(prepare.querySelector(".animate-spin")).toBeNull();
    await click(c.managed.inspect);
    expect(h.prepareManaged).toHaveBeenCalledTimes(2);
    expect(h.prepareManaged.mock.calls[1]![0].requestId).toBe(
      h.prepareManaged.mock.calls[0]![0].requestId,
    );
    expect(h.push).toHaveBeenCalledWith(
      `/servers/networks/preparations/${managedPreparationFixture().id}`,
    );
  });
  it("opens the saved preparation when its initial POST response was lost without submitting again", async () => {
    h.capabilities.mockResolvedValue({
      ...clusterCapabilitiesFixture(),
      modes: ["native", "wireguard"],
    });
    h.prepareManaged.mockImplementationOnce(async (input) => {
      h.managedPreparation.mockResolvedValue({
        ...managedPreparationFixture(),
        id: input.requestId,
        input,
      });
      throw new Error("Response lost after acceptance");
    });
    await startNetworkStep();
    await click(c.managed.inspect);
    const requestId = h.prepareManaged.mock.calls[0]![0].requestId;
    expect(h.managedPreparation).toHaveBeenCalledWith(requestId);
    expect(h.push).toHaveBeenCalledWith(`/servers/networks/preparations/${requestId}`);
    expect(h.prepareManaged).toHaveBeenCalledOnce();
    expect(h.applyManaged).not.toHaveBeenCalled();
    const prepare = host.querySelector<HTMLButtonElement>('button[aria-busy="true"]');
    expect(prepare?.disabled).toBe(true);
    expect(prepare?.textContent).toBe(c.managed.inspecting);
    await act(async () => prepare!.click());
    expect(h.prepareManaged).toHaveBeenCalledOnce();
    expect(h.push).toHaveBeenCalledOnce();
  });
  it("refuses expired plans after preparation and keeps the saved draft editable", async () => {
    const expired = managedOperationFixture();
    expired.plan.preparationId = managedPreparationFixture().id;
    expired.plan.expiresAt = new Date(Date.now() - 1).toISOString();
    h.managedOperation.mockResolvedValue(expired);
    await act(async () =>
      root.render(
        <I18nProvider>
          <PlatformProvider deployMode="desktop" selfHosted>
            <ManagedNetworkOperationPage id={expired.id} />
          </PlatformProvider>
        </I18nProvider>,
      ),
    );
    expect(host.textContent).toContain(c.managed.expired);
    const apply = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === c.managed.apply,
    )!;
    expect(apply.disabled).toBe(true);
    expect(h.applyManaged).not.toHaveBeenCalled();
    expect(
      host.querySelector(
        `a[href="/servers/networks/new?preparation=${expired.plan.preparationId}"]`,
      ),
    ).not.toBeNull();
  });
  it("reopens saved prerequisite failures, retries explicitly, and waits for review before apply", async () => {
    vi.useFakeTimers();
    const failed = managedPreparationFixture();
    failed.status = "failed";
    failed.error = "Python installation needs attention";
    failed.hosts[0]!.steps[2] = {
      ...failed.hosts[0]!.steps[2]!,
      status: "failed",
      message: "Package repository is unavailable",
    };
    failed.hosts[0]!.logs = [
      {
        timestamp: new Date().toISOString(),
        level: "error",
        step: "python3",
        message: "Repository connection refused",
      },
    ];
    h.managedPreparation.mockResolvedValue(failed);
    await act(async () =>
      root.render(
        <I18nProvider>
          <PlatformProvider deployMode="desktop" selfHosted>
            <ManagedNetworkPreparationPage id={failed.id} />
          </PlatformProvider>
        </I18nProvider>,
      ),
    );
    expect(host.textContent).toContain("Package repository is unavailable");
    expect(host.textContent).toContain("Repository connection refused");
    expect(host.textContent).toContain(c.managed.setupSteps.python3);
    const serverToggle = host.querySelector<HTMLButtonElement>(
      'button[aria-controls="network-steps-server-a"]',
    )!;
    expect(serverToggle.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector("#network-steps-server-a")).toBeNull();
    await act(async () => serverToggle.click());
    expect(host.querySelector("#network-steps-server-a")?.textContent).toContain(
      "Package repository is unavailable",
    );
    await act(async () => serverToggle.click());
    expect(h.prepareManaged).not.toHaveBeenCalled();
    await click(c.managed.retryPreparation);
    expect(h.prepareManaged).toHaveBeenCalledWith(failed.input);
    expect(host.textContent).toContain(c.managed.preparationStatus.preparing);
    await act(async () =>
      emitProgress("preparations", {
        ...failed,
        sequence: 3,
        status: "ready",
        error: null,
        operationId: managedOperationFixture().id,
      }),
    );
    expect(host.textContent).toContain(c.managed.preparationStatus.ready);
    expect(serverToggle.getAttribute("aria-expanded")).toBe("false");
    expect(
      host.querySelector(`a[href="/servers/networks/operations/${managedOperationFixture().id}"]`),
    ).not.toBeNull();
    expect(h.applyManaged).not.toHaveBeenCalled();
  });
  it("blocks an edit while managed recovery is pending and links to the operation", async () => {
    const operation = { ...managedOperationFixture(), status: "needs_attention" };
    h.get.mockResolvedValue({ ...serverClusterFixture(), operation });
    await render("cluster-a");
    expect(host.textContent).toContain(c.managed.recoveryHint);
    expect(
      host.querySelector(`a[href="/servers/networks/operations/${operation.id}"]`),
    ).not.toBeNull();
    expect(host.querySelector("input")).toBeNull();
  });
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
    expect(host.querySelector(`a[href="/servers/networks/${cluster.id}"]`)).not.toBeNull();
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
    await click(c.continue);
    const members = [...host.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')];
    await act(async () => {
      members[0]!.click();
      members[1]!.click();
    });
    expect(host.querySelector("h2")?.textContent).toBe(c.members);
    expect(document.activeElement).toBe(host.querySelector("h2"));
    await fill(host.querySelector('input[placeholder^="10.20.0.0/24"]'), "10.20.0.0/24");
    const addresses = host.querySelectorAll<HTMLInputElement>('input[placeholder="10.20.0.10"]');
    await fill(addresses[0]!, "10.20.0.2");
    await fill(addresses[1]!, "10.20.0.3");
    await click(c.back);
    expect(
      host.querySelector<HTMLInputElement>(`input[placeholder="${c.namePlaceholder}"]`)?.value,
    ).toBe("My fleet");
    await click(c.continue);
    expect(host.querySelectorAll('[role="checkbox"][aria-checked="true"]')).toHaveLength(2);
    expect(host.querySelector<HTMLInputElement>('input[placeholder^="10.20.0.0/24"]')?.value).toBe(
      "10.20.0.0/24",
    );
    await click(c.continue);
    expect(host.querySelector("h2")?.textContent).toBe(c.stepReview);
    expect(h.create).not.toHaveBeenCalled();
    await click(c.createAndVerify);
    expect(h.create).not.toHaveBeenCalled();
    expect(host.textContent).toContain(c.managed.firewallRules.nativeDescription);
    expect(firewallPanel().textContent).toContain("10.20.0.3/32");
    expect(firewallPanel().textContent).not.toContain("192.0.2.");
    expect(firewallPanel().querySelectorAll('[role="checkbox"]')).toHaveLength(1);
    expect(host.querySelector('aside [role="checkbox"]')).toBeNull();
    await confirmFirewall("native");
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
    expect(h.replace).toHaveBeenCalledWith("/servers/networks/cluster-a");
  });

  it("keeps the original revision and draft on edit conflicts, with Cancel returning to the cluster", async () => {
    h.update.mockRejectedValue(new Error("Cluster configuration changed. Reload before editing."));
    await render("cluster-a");
    await fill(host.querySelector(`input[placeholder="${c.namePlaceholder}"]`), "Changed fleet");
    await click(c.continue);
    await click(c.continue);
    await confirmFirewall("native");
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
    expect(h.push).toHaveBeenCalledWith("/servers/networks/cluster-a");
  });

  it("requires fresh firewall confirmation when a native verification port changes", async () => {
    await render("cluster-a");
    await click(c.continue);
    await click(c.continue);
    await confirmFirewall("native");
    expect(host.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("true");
    await click(c.back);
    await fill(
      [...host.querySelectorAll<HTMLInputElement>('input[type="number"]')].at(-1)!,
      "53001",
    );
    await click(c.continue);
    expect(host.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("false");
    expect(firewallPanel().textContent).toContain("53001");
    await click(c.saveAndVerify);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("repairs the mismatched ranges from actual server masks and saves through the existing flow", async () => {
    h.inspect.mockImplementation(async (id: string) =>
      observation(id === "server-a" ? "10.20.1.10" : "10.20.2.10", "eth1.4000"),
    );
    await startNetworkStep();
    await fill(host.querySelector('input[placeholder^="10.20.0.0/24"]'), "10.20.0.0/24");
    const addresses = host.querySelectorAll<HTMLInputElement>('input[placeholder="10.20.0.10"]');
    await fill(addresses[0]!, "10.20.1.10");
    await fill(addresses[1]!, "10.20.2.10");
    await click(c.continue);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Alpha");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(c.detectNetworkSettings);
    await click(c.detectNetworkSettings);
    expect(h.inspect.mock.calls.map(([id]) => id)).toEqual(["server-a", "server-b"]);
    expect(host.querySelector<HTMLInputElement>('input[placeholder^="10.20.0.0/24"]')?.value).toBe(
      "10.20.1.0/24, 10.20.2.0/24",
    );
    expect(
      [...host.querySelectorAll<HTMLInputElement>(`input[placeholder="${c.autoDetect}"]`)].map(
        (input) => input.value,
      ),
    ).toEqual(["eth1.4000", "eth1.4000"]);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.verify).not.toHaveBeenCalled();
    await click(c.continue);
    await confirmFirewall("native");
    await click(c.createAndVerify);
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({
        network: expect.objectContaining({ cidrs: ["10.20.1.0/24", "10.20.2.0/24"] }),
        members: [
          expect.objectContaining({
            serverId: "server-a",
            providerId: "custom",
            privateIp: "10.20.1.10",
            interfaceName: "eth1.4000",
          }),
          expect.objectContaining({
            serverId: "server-b",
            providerId: "custom",
            privateIp: "10.20.2.10",
            interfaceName: "eth1.4000",
          }),
        ],
      }),
    );
    expect(h.verify).toHaveBeenCalledTimes(1);
  });

  it("keeps ambiguous interfaces as an explicit choice and fills ranges when one is selected", async () => {
    const found = observation("10.20.0.2");
    found.interfaces.push(...observation("10.30.0.2", "eth2").interfaces);
    h.inspect.mockImplementation(async (id: string) =>
      id === "server-a" ? found : observation("10.20.0.3"),
    );
    await startNetworkStep();
    await click(c.detectNetworkSettings);
    const addresses = host.querySelectorAll<HTMLInputElement>('input[placeholder="10.20.0.10"]');
    expect(addresses[0]!.value).toBe("");
    expect(addresses[1]!.value).toBe("10.20.0.3");
    expect(host.textContent).toContain(c.chooseDetectedInterface);
    const choice = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("10.30.0.2/24"),
    );
    await act(async () => choice!.click());
    expect(addresses[0]!.value).toBe("10.30.0.2");
    expect(choice?.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector<HTMLInputElement>('input[placeholder^="10.20.0.0/24"]')?.value).toBe(
      "10.20.0.0/24, 10.30.0.0/24",
    );
    await click(c.continue);
    expect(host.querySelector("h2")?.textContent).toBe(c.stepReview);
  });

  it("shows missing networks and inspection failures per server without inventing addresses, and supports retry", async () => {
    h.inspect.mockImplementation(async (id: string) => {
      if (id === "server-b") throw new Error("SSH connection timed out");
      return observation("192.0.2.10", "eth0");
    });
    await startNetworkStep();
    await click(c.detectNetworkSettings);
    expect(host.textContent).toContain(c.noPrivateInterface);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("SSH connection timed out");
    expect(
      [...host.querySelectorAll<HTMLInputElement>('input[placeholder="10.20.0.10"]')].every(
        (input) => !input.value,
      ),
    ).toBe(true);
    expect(host.querySelector<HTMLInputElement>('input[placeholder^="10.20.0.0/24"]')?.value).toBe(
      "",
    );
    h.inspect.mockResolvedValue(observation("10.20.0.3"));
    const retry = [...host.querySelectorAll("button")].filter(
      (button) => button.textContent?.trim() === c.inspect,
    )[1];
    await act(async () => retry!.click());
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(
      host.querySelectorAll<HTMLInputElement>('input[placeholder="10.20.0.10"]')[1]?.value,
    ).toBe("10.20.0.3");
    expect(host.textContent).toContain(c.noPrivateInterface);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("limits concurrent inspections and locks the draft until all results are applied", async () => {
    h.servers.mockResolvedValue(
      Array.from({ length: 7 }, (_, i) => ({
        id: `server-${i}`,
        name: `Server ${i}`,
        sshHost: `192.0.2.${i + 1}`,
      })),
    );
    const pending = new Map<string, (value: NetworkHostObservation) => void>();
    h.inspect.mockImplementation(
      (id: string) => new Promise<NetworkHostObservation>((resolve) => pending.set(id, resolve)),
    );
    await startNetworkStep();
    await click(c.detectNetworkSettings);
    expect(h.inspect).toHaveBeenCalledTimes(3);
    expect(host.querySelector("fieldset")?.disabled).toBe(true);
    expect(
      [...host.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === c.continue,
      )?.disabled,
    ).toBe(true);
    for (const [start, count] of [
      [0, 3],
      [3, 3],
      [6, 1],
    ]) {
      await act(async () => {
        for (let i = start!; i < start! + count!; i++)
          pending.get(`server-${i}`)!(observation(`10.20.0.${i + 1}`));
      });
      expect(h.inspect).toHaveBeenCalledTimes(Math.min(start! + count! + 3, 7));
    }
    expect(host.querySelector("fieldset")?.disabled).toBe(false);
    expect(
      host.querySelectorAll<HTMLInputElement>('input[placeholder="10.20.0.10"]')[6]?.value,
    ).toBe("10.20.0.7");
    expect(h.create).not.toHaveBeenCalled();
  });
});
