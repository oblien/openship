// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { baseDictionary } from "@/i18n";
import { CloudResourceContext } from "@/context/CloudResourceContext";
import { ManagedServerSsh } from "./ManagedServerSsh";
import { ManagedServerRuntime } from "./ManagedServerRuntime";
import { ManagedServerWorkloads } from "./ManagedServerWorkloads";
import { ManagedServerNetwork } from "./ManagedServerNetwork";
import { ManagedServerSettings } from "./ManagedServerSettings";

const api = vi.hoisted(() => ({
  managedSshStatus: vi.fn(),
  setManagedSsh: vi.fn(),
  setManagedSshKey: vi.fn(),
  setManagedSshPassword: vi.fn(),
  managedSshConnection: vi.fn(),
  managedRuntimeStatus: vi.fn(),
  enableManagedRuntime: vi.fn(),
  managedRuntimeCredential: vi.fn(),
  rotateManagedRuntimeCredential: vi.fn(),
  managedWorkloads: vi.fn(),
  managedWorkloadLogs: vi.fn(),
  createManagedWorkload: vi.fn(),
  controlManagedWorkload: vi.fn(),
  managedInfo: vi.fn(),
  managedBootLogs: vi.fn(),
  getServerNetworkSettings: vi.fn(),
  updateServerNetworkSettings: vi.fn(),
}));
vi.mock("@/lib/api/system", () => ({ systemApi: api }));
const copy = baseDictionary.servers.managedControls;
const sshStatus = {
  enabled: false,
  keyConfigured: false,
  passwordConfigured: true,
  requiresIdentityAccess: false,
  connection: null,
};
const credential = {
  endpoint: "https://runtime.example.test",
  token: "super-private-runtime-token",
  revision: "a".repeat(64),
  expiresAt: "2030-10-10T00:00:00Z",
};
const network = {
  internetAccess: true,
  ingressPorts: [80, 9990],
  ingressAll: false,
  egress: ["*"],
  privateIp: "10.0.0.5",
  outboundIp: "192.0.2.2",
  outboundMode: "managed",
  revision: "a".repeat(64),
};
const manual = {
  id: "openship-manual-test",
  name: "Worker",
  state: "stopped",
  restartPolicy: "never",
  source: "manual",
  projectId: null,
  manageable: true,
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
let root: Root, host: HTMLDivElement;
const render = (node: ReactNode, scope = "account-a") =>
  act(async () =>
    root.render(
      <I18nProvider>
        <CloudResourceContext.Provider value={scope}>{node}</CloudResourceContext.Provider>
      </I18nProvider>,
    ),
  );
const buttons = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].filter(
    (node) => node.textContent?.trim() === label || node.getAttribute("aria-label") === label,
  );
const button = (label: string) => {
  const found = buttons(label);
  expect(found.length, label).toBeGreaterThan(0);
  return found[0]!;
};
async function fill(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    node.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const submit = async (form: HTMLFormElement) =>
  act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.managedSshStatus.mockResolvedValue(sshStatus);
  api.managedRuntimeStatus.mockResolvedValue({ enabled: true, running: true });
  api.managedRuntimeCredential.mockResolvedValue(credential);
  api.managedWorkloads.mockResolvedValue({ workloads: [], truncated: false });
  api.getServerNetworkSettings.mockResolvedValue(network);
  api.managedInfo.mockResolvedValue({
    workspaceId: "vm-a",
    image: "oblien/docker:29",
    state: "running",
    mode: "permanent",
    operatingSystem: "Alpine 3.22",
    restartPolicy: null,
    resources: { cpuCores: 2, memoryMb: 8192, diskMb: 32768 },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("reads runtime status without automatically enabling it or exposing a token", async () => {
  await render(<ManagedServerRuntime serverId="server-a" />);
  expect(api.managedRuntimeStatus).toHaveBeenCalledExactlyOnceWith("server-a");
  expect(api.managedRuntimeCredential).not.toHaveBeenCalled();
  expect(api.enableManagedRuntime).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain(credential.token);
  expect(host.textContent).toContain(copy.runtime.requiredHint);
});
it("reveals a credential only on request and clears it after a minute", async () => {
  await render(<ManagedServerRuntime serverId="server-a" />);
  vi.useFakeTimers();
  await act(async () => button(copy.runtime.reveal).click());
  expect(api.managedRuntimeCredential).toHaveBeenCalledExactlyOnceWith("server-a", {
    confirm: true,
  });
  expect(host.textContent).toContain(credential.token);
  expect(localStorage.getItem("oblien-runtime-token")).toBeNull();
  await act(async () => vi.advanceTimersByTime(60_000));
  expect(host.textContent).not.toContain(credential.token);
});
it("ignores a credential response arriving after an account or server switch", async () => {
  const pending = deferred<typeof credential>();
  api.managedRuntimeCredential.mockReturnValueOnce(pending.promise);
  await render(<ManagedServerRuntime serverId="server-a" />);
  await act(async () => button(copy.runtime.reveal).click());
  await render(<ManagedServerRuntime serverId="server-b" />, "account-b");
  await act(async () => pending.resolve(credential));
  expect(host.textContent).not.toContain(credential.token);
  expect(api.managedRuntimeStatus).toHaveBeenLastCalledWith("server-b");
});
it("does not restore a revealed credential after switching accounts and back", async () => {
  await render(<ManagedServerRuntime serverId="server-a" />);
  await act(async () => button(copy.runtime.reveal).click());
  expect(host.textContent).toContain(credential.token);
  await render(<ManagedServerRuntime serverId="server-a" />, "account-b");
  await render(<ManagedServerRuntime serverId="server-a" />, "account-a");
  expect(host.textContent).not.toContain(credential.token);
});
it("clears credentials in a hidden tab and discards replies while it is hidden", async () => {
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  try {
    await render(<ManagedServerRuntime serverId="server-a" />);
    await act(async () => button(copy.runtime.reveal).click());
    expect(host.textContent).toContain(credential.token);
    hidden.mockReturnValue(true);
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(host.textContent).not.toContain(credential.token);
    hidden.mockReturnValue(false);
    const pending = deferred<typeof credential>();
    api.managedRuntimeCredential.mockReturnValueOnce(pending.promise);
    await act(async () => button(copy.runtime.reveal).click());
    hidden.mockReturnValue(true);
    await act(async () => pending.resolve(credential));
    hidden.mockReturnValue(false);
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(host.textContent).not.toContain(credential.token);
  } finally {
    hidden.mockRestore();
  }
});
it("clears a revealed credential when navigating to another tab", async () => {
  await render(<ManagedServerRuntime serverId="server-a" />);
  await act(async () => button(copy.runtime.reveal).click());
  expect(host.textContent).toContain(credential.token);
  await render(<ManagedServerSsh serverId="server-a" />);
  await render(<ManagedServerRuntime serverId="server-a" />);
  expect(host.textContent).not.toContain(credential.token);
});
it("requires a separate confirmation for rotation and sends its revision", async () => {
  api.rotateManagedRuntimeCredential.mockResolvedValue({
    ...credential,
    token: "new-token",
    revision: "b".repeat(64),
  });
  await render(<ManagedServerRuntime serverId="server-a" />);
  await act(async () => button(copy.runtime.reveal).click());
  await act(async () => button(copy.runtime.rotate).click());
  expect(api.rotateManagedRuntimeCredential).not.toHaveBeenCalled();
  await act(async () => button(copy.runtime.confirmRotate).click());
  expect(api.rotateManagedRuntimeCredential).toHaveBeenCalledExactlyOnceWith("server-a", {
    expectedRevision: credential.revision,
    confirm: true,
  });
  expect(host.textContent).toContain("new-token");
  expect(host.textContent).not.toContain(credential.token);
});
it("does not label an unavailable runtime as disabled or offer to turn it on", async () => {
  api.managedRuntimeStatus.mockRejectedValueOnce(new Error("Provider status unavailable"));
  await render(<ManagedServerRuntime serverId="server-a" />);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "Provider status unavailable",
  );
  expect(buttons(copy.runtime.enable)).toHaveLength(0);
  await act(async () => button(copy.retry).click());
  expect(buttons(copy.runtime.reveal)).toHaveLength(1);
});
it("shows safe stopped-server advice and disables token reveal", async () => {
  api.managedRuntimeStatus.mockResolvedValue({ enabled: true, running: false });
  await render(<ManagedServerRuntime serverId="server-a" />);
  expect(button(copy.runtime.reveal).disabled).toBe(true);
  expect(host.textContent).toContain(copy.runtime.stoppedHint);
});
it("enables SSH once and shows the one-time password without repeating the request", async () => {
  const pending = deferred<unknown>();
  api.setManagedSsh.mockReturnValueOnce(pending.promise);
  await render(<ManagedServerSsh serverId="server-a" />);
  const enable = button(copy.ssh.enable);
  await act(async () => {
    enable.click();
    enable.click();
  });
  expect(api.setManagedSsh).toHaveBeenCalledExactlyOnceWith("server-a", {
    enabled: true,
    expectedEnabled: false,
    confirm: true,
  });
  await act(async () =>
    pending.resolve({ status: { ...sshStatus, enabled: true }, initialPassword: "initial-secret" }),
  );
  expect(host.textContent).toContain("initial-secret");
  await act(async () => button(copy.hideSecrets).click());
  expect(host.textContent).not.toContain("initial-secret");
});
it("asks for SSH disable confirmation and keeps errors visible", async () => {
  api.managedSshStatus.mockResolvedValue({ ...sshStatus, enabled: true });
  api.setManagedSsh.mockRejectedValue(new Error("Server is busy"));
  await render(<ManagedServerSsh serverId="server-a" />);
  await act(async () => button(copy.ssh.disable).click());
  expect(api.setManagedSsh).not.toHaveBeenCalled();
  expect(host.textContent).toContain(copy.ssh.disableHint);
  await act(async () => button(copy.ssh.confirmDisable).click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Server is busy");
  expect(buttons(copy.ssh.disable)).toHaveLength(1);
});
it("submits only the public key and clears a password immediately after submission", async () => {
  api.managedSshStatus.mockResolvedValue({ ...sshStatus, enabled: true });
  api.setManagedSshKey.mockResolvedValue({ ...sshStatus, enabled: true, keyConfigured: true });
  api.setManagedSshPassword.mockRejectedValue(new Error("Try again"));
  await render(<ManagedServerSsh serverId="server-a" />);
  const key = "ssh-ed25519 AAAApublic-key-fixture";
  await fill(host.querySelector("textarea")!, key);
  await submit(host.querySelector("form")!);
  expect(api.setManagedSshKey).toHaveBeenCalledExactlyOnceWith("server-a", {
    publicKey: key,
    confirm: true,
  });
  const password = host.querySelector<HTMLInputElement>('input[type="password"]')!;
  await fill(password, "do-not-retain-this");
  await submit(password.closest("form")!);
  expect(api.setManagedSshPassword).toHaveBeenCalledExactlyOnceWith("server-a", {
    password: "do-not-retain-this",
    confirm: true,
  });
  expect(password.value).toBe("");
  expect(host.textContent).not.toContain("do-not-retain-this");
});
it("edits outbound destinations with their revision and never sends ingress/proxy fields", async () => {
  api.updateServerNetworkSettings.mockResolvedValue({
    ...network,
    egress: ["api.example.test"],
    revision: "b".repeat(64),
  });
  await render(<ManagedServerNetwork serverId="server-a" />);
  await fill(host.querySelector("textarea")!, "API.example.test\napi.example.test");
  await act(async () => button(copy.save).click());
  expect(api.updateServerNetworkSettings).toHaveBeenCalledExactlyOnceWith("server-a", {
    internetAccess: true,
    expectedInternetAccess: true,
    egress: ["api.example.test"],
    expectedRevision: network.revision,
    confirm: true,
  });
  expect(host.textContent).toContain(copy.saved);
});
it("blocks malformed outbound lists and preserves the draft on conflict", async () => {
  await render(<ManagedServerNetwork serverId="server-a" />);
  await fill(host.querySelector("textarea")!, "*\ngithub.com");
  expect(button(copy.save).disabled).toBe(true);
  await fill(host.querySelector("textarea")!, "github.com");
  api.updateServerNetworkSettings.mockRejectedValue(new Error("Network settings changed"));
  await act(async () => button(copy.save).click());
  expect(host.querySelector("textarea")!.value).toBe("github.com");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Network settings changed");
});
it("shows wildcard ingress accurately and keeps unavailable rules read-only", async () => {
  api.getServerNetworkSettings.mockResolvedValue({ ...network, ingressAll: true, egress: null });
  await render(<ManagedServerNetwork serverId="server-a" />);
  expect(host.textContent).toContain(copy.network.allPorts);
  expect(host.querySelector("textarea")!.disabled).toBe(true);
  expect(host.textContent).toContain(copy.network.rulesUnavailable);
});
it("lists native workloads without offering direct controls for managed application/system processes", async () => {
  api.managedWorkloads.mockResolvedValue({
    workloads: [
      manual,
      {
        ...manual,
        id: "openship-app",
        name: "API app",
        source: "project",
        projectId: "project-a",
        manageable: false,
      },
      {
        ...manual,
        id: "openship-docker-api-v1",
        name: "Docker bridge",
        source: "system",
        manageable: false,
      },
    ],
    truncated: false,
  });
  await render(<ManagedServerWorkloads serverId="server-a" />);
  const articles = host.querySelectorAll("article");
  expect(articles).toHaveLength(3);
  expect(articles[0]!.textContent).toContain(copy.workloads.start);
  expect(articles[1]!.querySelector("a")?.getAttribute("href")).toBe("/projects/project-a");
  for (const article of [articles[1]!, articles[2]!]) {
    expect(
      [...article.querySelectorAll("button")].some(
        (node) => node.textContent === copy.workloads.delete,
      ),
    ).toBe(false);
    expect(article.textContent).toContain(copy.workloads.protected);
  }
});
it("retries a lost workload create response with the same immutable payload", async () => {
  api.createManagedWorkload
    .mockRejectedValueOnce(new Error("Lost response"))
    .mockResolvedValueOnce(manual);
  await render(<ManagedServerWorkloads serverId="server-a" />);
  await act(async () => button(copy.workloads.create).click());
  await fill(host.querySelector<HTMLInputElement>('input[id$="-name"]')!, "Worker");
  await fill(
    host.querySelector<HTMLTextAreaElement>('textarea[id$="-command"]')!,
    "node worker.js",
  );
  await fill(host.querySelector<HTMLTextAreaElement>('textarea[id$="-env"]')!, "TOKEN=private");
  await submit(host.querySelector("form")!);
  expect(host.querySelector<HTMLInputElement>('input[id$="-name"]')!.disabled).toBe(true);
  const first = api.createManagedWorkload.mock.calls[0]!;
  await submit(host.querySelector("form")!);
  expect(api.createManagedWorkload.mock.calls[1]).toEqual(first);
  expect(first[1]).toMatchObject({
    name: "Worker",
    command: "node worker.js",
    environment: ["TOKEN=private"],
    confirm: true,
  });
  expect(first[1].idempotencyKey.length).toBeGreaterThanOrEqual(16);
  expect(host.querySelector("form")).toBeNull();
  expect(host.textContent).not.toContain("TOKEN=private");
});
it("confirms workload actions and reads only the selected process logs", async () => {
  api.managedWorkloads.mockResolvedValue({ workloads: [manual], truncated: false });
  api.controlManagedWorkload.mockResolvedValue({
    ok: true,
    workload: { ...manual, state: "running" },
  });
  api.managedWorkloadLogs.mockResolvedValue({ logs: "worker ready", truncated: false });
  await render(<ManagedServerWorkloads serverId="server-a" />);
  await act(async () => button(copy.workloads.start).click());
  expect(api.controlManagedWorkload).not.toHaveBeenCalled();
  await act(async () => button(copy.workloads.start).click());
  expect(api.controlManagedWorkload).toHaveBeenCalledExactlyOnceWith("server-a", {
    workloadId: manual.id,
    action: "start",
    confirm: true,
  });
  await act(async () => button(copy.workloads.logs).click());
  expect(api.managedWorkloadLogs).toHaveBeenCalledExactlyOnceWith("server-a", {
    workloadId: manual.id,
    tail: 200,
  });
  expect(host.textContent).toContain("worker ready");
});
it("shows managed image details and delegates capacity changes to the existing resize flow", async () => {
  const resize = vi.fn();
  const actions = { busy: false, previewResize: resize } as any;
  api.managedBootLogs.mockResolvedValue({ logs: "boot complete", truncated: false });
  await render(<ManagedServerSettings serverId="server-a" actions={actions} />);
  expect(host.textContent).toContain("oblien/docker:29");
  expect(host.textContent).toContain(copy.settings.imageHint);
  await act(async () => button(baseDictionary.billing.workspaces.resize).click());
  expect(resize).toHaveBeenCalledOnce();
  expect(api.managedBootLogs).not.toHaveBeenCalled();
  await act(async () => button(copy.settings.bootLogs).click());
  expect(host.textContent).toContain("boot complete");
  expect(host.querySelector('a[href="/servers/server-a?tab=terminal"]')).not.toBeNull();
});
it("does not keep a previous server's read after a target change", async () => {
  const pending = deferred<typeof network>();
  api.getServerNetworkSettings
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce({ ...network, privateIp: "10.0.0.8" });
  await render(<ManagedServerNetwork serverId="server-a" />);
  await render(<ManagedServerNetwork serverId="server-b" />);
  await act(async () => pending.resolve(network));
  expect(host.textContent).toContain("10.0.0.8");
  expect(host.textContent).not.toContain("10.0.0.5");
});
