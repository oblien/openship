// @vitest-environment happy-dom
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudWorkspaceSummary, ServerDetail } from "@repo/contracts";
import { I18nProvider } from "@/components/i18n-provider";
import { baseDictionary } from "@/i18n";
import { PlatformProvider } from "@/context/PlatformContext";
import { AppDestinationPicker, type AppDestination } from "@/components/deploy/AppDestinationPicker";
import ServerSelector from "@/components/shared/ServerSelector";
import { BillingLink, BillingWorkspaceProvider, workspaceBillingHref } from "@/components/billing/BillingWorkspaceContext";
import { ApiError } from "@/lib/api/client";
import { ServerUsage } from "./ServerUsage";
import { ManagedServerPlan } from "./managed/ManagedServerPlan";
import { ManagedServerActionFeedback } from "./managed/ManagedServerActionFeedback";
import { ServerCapacityRecovery } from "./managed/ServerCapacityRecovery";
import { useManagedServerActions } from "./managed/useManagedServerActions";

const h = vi.hoisted(() => ({
  organizationId: "org-a", list: vi.fn(), usage: vi.fn(), ensure: vi.fn(),
  previewResize: vi.fn(), resize: vi.fn(), add: vi.fn(), retry: vi.fn(),
}));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "user-a" }, session: { activeOrganizationId: h.organizationId } } }),
}));
vi.mock("@/lib/api/system", () => ({ systemApi: {
  listServerDestinations: h.list, serverUsage: h.usage, ensureServer: h.ensure,
  previewServerResize: h.previewResize, resizeServer: h.resize,
} }));
vi.mock("@/lib/api/settings", () => ({ settingsApi: { get: async () => ({ defaultServerId: null }) } }));
vi.mock("@/components/servers/add-server-modal", () => ({ useAddServerModal: () => h.add }));

const copy = baseDictionary.billing.workspaces;
const workspace: CloudWorkspaceSummary = {
  id: "cws-a", serverId: "managed-a", name: "Production", planTierId: "hobby",
  subscriptionStatus: "active", projectCount: 2, state: "running", operation: null,
  resources: { cpuCores: 1, memoryMb: 4096, diskMb: 25600 }, createdAt: "2026-10-01T00:00:00Z",
};
const server: ServerDetail = {
  id: workspace.serverId, name: workspace.name, managed: workspace, connection: "cloud",
  isLocal: false, sshHost: null, sshPort: null, sshUser: null, sshAuthMethod: null,
  sshKeyPath: null, hasStoredKeyMaterial: false, sshJumpHost: null, sshArgs: null,
  createdAt: workspace.createdAt, country: null, sshTransport: "direct", projectCount: 2,
  hostChannel: null, capabilities: { monitor: true, terminal: true, exec: true, hostConfiguration: false, ssh: false },
};
const usage = {
  measuredAt: "2026-10-01T00:00:00Z", available: true, reason: null, cpuPercent: 23,
  memoryUsedMb: 512, memoryAvailableMb: 3584, diskUsedMb: 2048, diskAvailableMb: 23552,
  diskTotalMb: 25600, sharedDiskMb: 1024, projects: [{ id: "p-a", name: "API", diskMb: 1024 }],
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
let root: Root;
let host: HTMLDivElement;
const render = (children: ReactNode, selfHosted = false) => act(async () => root.render(
  <I18nProvider><PlatformProvider selfHosted={selfHosted}>{children}</PlatformProvider></I18nProvider>,
));
const button = (label: string) => {
  const result = [...host.querySelectorAll<HTMLButtonElement>("button")].find(node =>
    node.textContent?.trim() === label || node.getAttribute("aria-label") === label);
  expect(result, label).toBeDefined();
  return result!;
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.organizationId = "org-a";
  h.list.mockResolvedValue({ servers: [server] });
  h.usage.mockResolvedValue(usage);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("selects the only server without provisioning anything on render", async () => {
  const change = vi.fn();
  await render(<ServerSelector forDeployment onSelect={change} />);
  expect(change).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: server.id }));
  expect(host.textContent).toContain("Production");
  expect(host.querySelector('[role="combobox"]')).toBeNull();
  expect(h.ensure).not.toHaveBeenCalled();
  expect(h.add).not.toHaveBeenCalled();
});
it.each([true, false])("uses an acquired server for catalog apps (self-hosted: %s)", async selfHosted => {
  const changed = vi.fn(), ready = vi.fn();
  function Picker() {
    const [value, setValue] = useState<AppDestination | null>(null);
    return <AppDestinationPicker value={value} onReadyChange={ready} onChange={next => { changed(next); setValue(next); }} />;
  }
  await render(<Picker />, selfHosted);
  expect(changed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    deployTarget: "cloud", serverId: server.id, workspaceId: workspace.id,
  }));
  expect(ready).toHaveBeenLastCalledWith(true);
  expect(h.ensure).not.toHaveBeenCalled();
});
it("requires acquiring a server on self-hosted instead of emitting an unbound Cloud target", async () => {
  h.list.mockResolvedValue({ servers: [] });
  const change = vi.fn(), ready = vi.fn();
  await render(<AppDestinationPicker value={null} onChange={change} onReadyChange={ready} />, true);
  expect(ready).toHaveBeenLastCalledWith(false);
  expect(change).not.toHaveBeenCalled();
  await act(async () => button(baseDictionary.widgets.shared.serverSelector.addServer).click());
  expect(h.add).toHaveBeenCalledOnce();
  expect(change).not.toHaveBeenCalled();
});
it("keeps first-subscription setup read-only on Cloud", async () => {
  h.list.mockResolvedValue({ servers: [] });
  await render(<ServerSelector forDeployment onSelect={vi.fn()} />);
  expect(host.textContent).toContain(copy.defaultHint);
  expect(h.ensure).not.toHaveBeenCalled();
  expect(h.add).not.toHaveBeenCalled();
});
it("ignores a destination response from the previous organization", async () => {
  const old = deferred<unknown>();
  h.list.mockReturnValueOnce(old.promise);
  const change = vi.fn();
  await render(<ServerSelector forDeployment onSelect={change} />);
  h.organizationId = "org-b";
  h.list.mockResolvedValue({ servers: [{ ...server, id: "managed-b", name: "Other team" }] });
  await render(<ServerSelector forDeployment onSelect={change} />);
  await act(async () => old.resolve({ servers: [{ ...server, name: "Previous team" }] }));
  expect(host.textContent).toContain("Other team");
  expect(host.textContent).not.toContain("Previous team");
  expect(change).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "managed-b" }));
});
it("keeps a saved binding readable without listing other servers", async () => {
  const ready = vi.fn();
  await render(<ServerSelector readOnly value={server.id} selectedName="Saved destination" onSelect={vi.fn()} onReadyChange={ready} />);
  expect(host.textContent).toContain("Saved destination");
  expect(h.list).not.toHaveBeenCalled();
  expect(ready).toHaveBeenLastCalledWith(true);
});

function Actions({ initial = workspace }: { initial?: CloudWorkspaceSummary }) {
  const [row, setRow] = useState(initial);
  const actions = useManagedServerActions(row.serverId, setRow);
  return <><ManagedServerPlan server={row} actions={actions} />
    <ManagedServerActionFeedback server={row} actions={actions} deleting={false} onCancelDelete={() => {}} /></>;
}
it("resumes a stopped server only once when the button is pressed twice", async () => {
  const pending = deferred<CloudWorkspaceSummary>();
  h.ensure.mockReturnValue(pending.promise);
  await render(<Actions initial={{ ...workspace, state: "stopped" }} />);
  await act(async () => { button(copy.resume).click(); button(copy.resume).click(); });
  expect(h.ensure).toHaveBeenCalledExactlyOnceWith(server.id);
  expect(button(copy.resume).disabled).toBe(true);
  await act(async () => pending.resolve(workspace));
  expect(host.textContent).not.toContain(copy.resume);
});
it("retains the reviewed resize and request key after an uncertain response", async () => {
  const preview = { revision: "a".repeat(64), before: workspace.resources,
    after: { cpuCores: 2, memoryMb: 8192, diskMb: 32768 }, restartProjects: [{ id: "p-a", name: "API" }] };
  h.previewResize.mockResolvedValue(preview);
  h.resize.mockRejectedValueOnce(new ApiError(504, "Gateway Timeout", { error: "Request timed out" }));
  await render(<Actions />);
  await act(async () => button(copy.resize).click());
  expect(host.textContent).toContain("API");
  expect(h.resize).not.toHaveBeenCalled();
  await act(async () => button(copy.confirmResize).click());
  const request = h.resize.mock.calls[0]![1];
  expect(request).toMatchObject({ revision: preview.revision, confirmRestart: true });
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Request timed out");
  h.resize.mockResolvedValue({ ...workspace, state: "queued" });
  await act(async () => button(copy.confirmResize).click());
  expect(h.resize.mock.calls[1]).toEqual([server.id, request]);
});
it("clears stale measurements when a server usage refresh fails", async () => {
  await render(<ServerUsage serverId={server.id} resources={workspace.resources} showProjects />);
  expect(host.textContent).toContain("API");
  h.usage.mockRejectedValue(new ApiError(503, "Service Unavailable", { error: "Server unreachable" }));
  await act(async () => button(baseDictionary.billing.resourceOverview.refresh).click());
  expect(host.textContent).not.toContain("API");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Server unreachable");
});
it("opens capacity recovery for the affected server without changing another server's subscription", async () => {
  h.list.mockResolvedValue({ servers: [{ ...server, id: "other", managed: { ...workspace, id: "other-workspace" } }, server] });
  await render(<ServerCapacityRecovery workspaceId={workspace.id} onClose={() => {}} onRetry={h.retry} />);
  expect(host.querySelector('a')?.getAttribute("href")).toBe(`/servers/${server.id}`);
  expect(h.resize).not.toHaveBeenCalled();
  await act(async () => button(copy.retryDeployment).click());
  expect(h.retry).toHaveBeenCalledOnce();
});
it("preserves the server subscription in billing navigation", async () => {
  expect(workspaceBillingHref("/billing/usage?workspaceId=old&groupBy=day#chart", "new"))
    .toBe("/billing/usage?workspaceId=new&groupBy=day#chart");
  await render(<BillingWorkspaceProvider workspaceId="cws-b"><BillingLink href="/billing/plans">Plans</BillingLink></BillingWorkspaceProvider>);
  expect(host.querySelector("a")?.getAttribute("href")).toBe("/billing/plans?workspaceId=cws-b");
});
