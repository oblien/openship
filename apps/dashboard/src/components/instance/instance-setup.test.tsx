// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { baseDictionary } from "@/i18n";
import { ApiError } from "@/lib/api/client";
import type { InstanceStatus } from "@/lib/api/instance";
import { InstanceLocation } from "./InstanceLocation";
import { INSTANCE_MOVE_HREF } from "./InstanceMoveLink";
import { TeamReachabilityCard } from "@/app/(dashboard)/settings/_components/TeamReachabilityCard";
import { GitSettings } from "@/app/(dashboard)/projects/[id]/components/GitSettings";

const h = vi.hoisted(() => ({
  status: vi.fn(),
  preflight: vi.fn(),
  provision: vi.fn(),
  move: vi.fn(),
  pair: vi.fn(),
  offer: vi.fn(),
  connectedSource: vi.fn(),
  returnToDesktop: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  toast: vi.fn(),
  refreshGit: vi.fn(),
  setAutoDeploy: vi.fn(),
  selfHosted: true,
  strategy: "none" as string,
  servers: [
    {
      id: "first",
      name: "First server",
      sshHost: "192.0.2.10",
      sshUser: "root",
      sshPort: 22,
      capabilities: { ssh: true },
    },
    {
      id: "selected",
      name: "Selected server",
      sshHost: "192.0.2.11",
      sshUser: "root",
      sshPort: 22,
      capabilities: { ssh: true },
    },
  ],
}));
vi.mock("@/lib/api/instance", () => ({
  instanceApi: {
    status: h.status,
    preflight: h.preflight,
    provision: h.provision,
    move: h.move,
    pair: h.pair,
    offer: h.offer,
    connectedSource: h.connectedSource,
    returnToDesktop: h.returnToDesktop,
  },
}));
vi.mock("@/lib/api", () => ({
  api: { get: h.get, post: h.post },
  getApiErrorMessage: (error: Error) => error.message,
  projectsApi: { getCloneToken: async () => ({ hasToken: false }), setAutoDeploy: h.setAutoDeploy },
}));
vi.mock("@/hooks/useServerDestinations", () => ({
  useServerDestinations: () => ({
    data: { servers: h.servers },
    loading: false,
    error: null,
    refresh() {},
    contextKey: "fixture",
    resourceKey: "fixture",
  }),
}));
vi.mock("@/components/servers/add-server-modal", () => ({ useAddServerModal: () => () => {} }));
vi.mock("@/context/PlatformContext", () => ({
  usePlatform: () => ({ selfHosted: h.selfHosted, deployMode: "desktop" }),
}));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: h.toast }) }));
vi.mock("@/context/GitHubContext", () => ({ useGitHub: () => ({ connected: true }) }));
vi.mock("@/context/ProjectSettingsContext", () => ({
  useProjectSettings: () => ({
    id: "project",
    projectData: { id: "project", gitRepo: "repo", gitOwner: "owner", deployTarget: "server" },
    servicesData: { services: [], isLoading: false, error: null },
    gitData: {
      repository: { url: "https://github.com/example/repo", full_name: "example/repo" },
      branch: "main",
      recentCommits: [],
      webhookStrategy: h.strategy,
      autoDeployEnabled: false,
    },
    refreshGit: h.refreshGit,
  }),
}));
// Unrelated editors have their own contexts. Keep the actual Git gate and link.
vi.mock("@/app/(dashboard)/library/components/RepositoryList", () => ({
  RepositoryList: () => null,
}));
vi.mock("@/app/(dashboard)/projects/[id]/components/AppSource", () => ({ AppSource: () => null }));
vi.mock("@/app/(dashboard)/projects/[id]/components/ReleaseImageSourceSettings", () => ({
  ReleaseImageSourceSettings: () => null,
}));
vi.mock("@/components/project-settings/ServerSideSwitch", () => ({
  Toggle: ({ checked, onChange, ...props }: { checked: boolean; onChange: () => void }) => (
    <button {...props} role="switch" aria-checked={checked} onClick={onChange} />
  ),
}));

const copy = baseDictionary.settings.instance.location;
const transfer = baseDictionary.settings.instance.transfer;
const fresh: InstanceStatus = {
  protocol: 1,
  role: "active",
  installationId: "fixture",
  version: "0.8.2",
  desktop: true,
  accountReady: false,
  connection: null,
  localHosts: [],
  handoff: null,
};
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected network request in instance setup test");
    }),
  );
  h.status.mockResolvedValue(fresh);
  h.get.mockResolvedValue({ data: [] });
  h.post.mockResolvedValue({ success: true });
  h.preflight.mockResolvedValue({ ready: true });
  h.provision.mockResolvedValue({});
  h.move.mockResolvedValue({});
  h.pair.mockResolvedValue({ code: "one-time-fixture" });
  h.offer.mockResolvedValue({ code: "move-code-fixture" });
  h.connectedSource.mockResolvedValue({ localHosts: [] });
  h.returnToDesktop.mockResolvedValue({});
  h.selfHosted = true;
  h.strategy = "none";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render(content: ReactNode) {
  await act(async () => root.render(<I18nProvider>{content}</I18nProvider>));
}
function visible<T extends HTMLElement>(selector: string) {
  return [...document.querySelectorAll<T>(selector)].filter((node) => !node.closest("[hidden]"));
}
function button(label: string, exact = true) {
  const node = visible<HTMLButtonElement>("button").find((el) =>
    exact ? el.textContent?.trim() === label : el.textContent?.includes(label),
  );
  expect(node, `button: ${label}`).toBeDefined();
  return node!;
}
async function click(node: HTMLElement) {
  expect(node).toBeTruthy();
  await act(async () => node.click());
}
async function edit(selector: string, value: string) {
  const input = visible<HTMLInputElement | HTMLTextAreaElement>(selector)[0];
  expect(input).toBeDefined();
  await act(async () => {
    const prototype =
      input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function chooseDestination() {
  await click(
    document.querySelector<HTMLElement>(
      '[aria-haspopup="listbox"][aria-label="Destination server"]',
    )!,
  );
  await click(
    visible<HTMLElement>('[role="option"]').find((node) =>
      node.textContent?.includes("Selected server"),
    )!,
  );
  await click(button("Desktop + browser", false));
  await edit('input[aria-label="Instance address"]', "ops.example.test");
}
async function openFreshMove() {
  await render(<InstanceLocation initial={fresh} />);
  await click(button(copy.moveToServer));
  expect(visible('input[type="password"]')).toHaveLength(0);
  expect(button(copy.continueSetup).disabled).toBe(true);
  await chooseDestination();
  await click(button(copy.continueSetup));
  expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe(
    copy.secureAccount,
  );
}
async function submitAccount() {
  await edit('input[autocomplete="name"]', "Instance owner");
  await edit('input[autocomplete="email"]', "owner@example.test");
  await edit('input[autocomplete="new-password"]', "fixture-password-only");
  await act(async () => {
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}
function expectNoMove() {
  expect(h.preflight).not.toHaveBeenCalled();
  expect(h.provision).not.toHaveBeenCalled();
  expect(h.move).not.toHaveBeenCalled();
  expect(h.returnToDesktop).not.toHaveBeenCalled();
}

describe("instance move setup", () => {
  it("opens connection directly from Desktop without entering move setup or duplicating menu actions", async () => {
    await render(<InstanceLocation initial={fresh} />);
    expect(button(copy.connectExisting)).toBeDefined();
    expect(button(copy.moveToServer)).toBeDefined();
    await click(document.querySelector<HTMLElement>(`[aria-label="${copy.moreOptions}"]`)!);
    for (const label of [copy.connectExisting, copy.moveToServer])
      expect(
        visible<HTMLButtonElement>("button").filter((node) => node.textContent?.trim() === label),
      ).toHaveLength(1);
    await click(button(copy.connectExisting));
    expect(document.querySelector('input[inputmode="url"]')).not.toBeNull();
    expect(document.querySelector('input[aria-label="Instance address"]')).toBeNull();
    expectNoMove();
  });
  it("shows both server move directions and creates a source code only after consent", async () => {
    const state = { ...fresh, desktop: false, accountReady: true };
    h.status.mockResolvedValue(state);
    await render(<InstanceLocation initial={state} />);
    expect(button(copy.pairDesktop)).toBeDefined();
    expect(button(copy.moveToAnotherServer)).toBeDefined();
    await click(button(copy.moveToDesktop));
    expect(button(transfer.createMoveCode).disabled).toBe(true);
    expect(h.offer).not.toHaveBeenCalled();
    await click(visible<HTMLElement>('[role="checkbox"]')[0]!);
    await click(button(transfer.createMoveCode));
    expect(h.offer).toHaveBeenCalledExactlyOnceWith("source", undefined);
    const moveCode = document.querySelector<HTMLTextAreaElement>(
      `textarea[aria-label="${transfer.moveCode}"]`,
    );
    expect(moveCode?.value).toBe("move-code-fixture");
    expect(moveCode?.readOnly).toBe(true);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      transfer.pasteMoveCode,
    );
    expect(h.pair).not.toHaveBeenCalled();
    expectNoMove();
  });
  it("requires fresh replacement consent when changing from installation to an existing instance", async () => {
    const state = { ...fresh, accountReady: true };
    h.status.mockResolvedValue(state);
    await render(<InstanceLocation initial={state} />);
    await click(button(copy.moveToServer));
    await chooseDestination();
    await click(visible<HTMLElement>('[role="checkbox"]')[0]!);
    expect(button("Move instance").disabled).toBe(false);
    await click(button(transfer.existingInstance));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(copy.receiveInstance);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      transfer.replaceDestinationConfirmation,
    );
    await edit(
      `textarea[aria-label="${transfer.destinationCodeLabel}"]`,
      "destination-receive-code",
    );
    expect(button("Move instance").disabled).toBe(true);
    expectNoMove();
    await click(visible<HTMLElement>('[role="checkbox"]')[0]!);
    await click(button("Move instance"));
    expect(h.move).toHaveBeenCalledExactlyOnceWith("destination-receive-code", undefined);
    expect(h.offer).not.toHaveBeenCalled();
    expect(h.provision).not.toHaveBeenCalled();
  });
  it("separates incoming move codes from receive-code generation and resets consent between them", async () => {
    const state = { ...fresh, accountReady: true };
    h.status.mockResolvedValue(state);
    await render(<InstanceLocation initial={state} />);
    await click(document.querySelector<HTMLElement>(`[aria-label="${copy.moreOptions}"]`)!);
    await click(button(copy.receiveInstance));
    await click(visible<HTMLElement>('[role="checkbox"]')[0]!);
    expect(button("Move instance").disabled).toBe(true);
    expect(h.offer).not.toHaveBeenCalled();
    await edit(`textarea[aria-label="${transfer.sourceCodeLabel}"]`, "source-move-code");
    expect(button("Move instance").disabled).toBe(false);
    await click(button(transfer.createReceiveCode));
    const create = () =>
      visible<HTMLButtonElement>('button:not([role="tab"])').find(
        (node) => node.textContent?.trim() === transfer.createReceiveCode,
      )!;
    expect(create().disabled).toBe(true);
    expect(visible("textarea")).toHaveLength(0);
    expectNoMove();
    await click(visible<HTMLElement>('[role="checkbox"]')[0]!);
    await click(create());
    expect(h.offer).toHaveBeenCalledExactlyOnceWith("target");
    const receiveCode = document.querySelector<HTMLTextAreaElement>(
      `textarea[aria-label="${transfer.receiveCode}"]`,
    );
    expect(receiveCode?.value).toBe("move-code-fixture");
    expect(receiveCode?.readOnly).toBe(true);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      transfer.existingInstance,
    );
    expectNoMove();
  });
  const connected: InstanceStatus = {
    ...fresh,
    accountReady: true,
    role: "connected",
    connection: { origin: "https://ops.example.test", installationId: "remote" },
    localHosts: [{ id: "desktop-host", name: "Separate local instance" }],
  };
  async function openReturn() {
    h.status.mockResolvedValue(connected);
    await render(<InstanceLocation initial={connected} />);
    await click(button(copy.returnToDesktop));
  }
  it("uses the hosted instance's source connection when returning to Desktop", async () => {
    h.connectedSource.mockResolvedValue({ localHosts: [{ id: "hosted", name: "Hosted apps" }] });
    await openReturn();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Keep access to Hosted apps",
    );
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain(
      "Separate local instance",
    );
    await click(visible<HTMLElement>('[role="checkbox"]')[0]!);
    expect(button("Move to Desktop").disabled).toBe(true);
    await click(
      document.querySelector<HTMLElement>(
        '[aria-haspopup="listbox"][aria-label="Source host connection"]',
      )!,
    );
    await click(
      visible<HTMLElement>('[role="option"]').find((node) =>
        node.textContent?.includes("Selected server"),
      )!,
    );
    expect(h.returnToDesktop).not.toHaveBeenCalled();
    await click(button("Move to Desktop"));
    expect(h.returnToDesktop).toHaveBeenCalledExactlyOnceWith({
      sourceServerId: "hosted",
      connectionServerId: "selected",
    });
  });
  it("waits for the remote source check and keeps confirmation separate", async () => {
    let resolve!: (value: { localHosts: [] }) => void;
    h.connectedSource.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await openReturn();
    await click(visible<HTMLElement>('[role="checkbox"]')[0]!);
    expect(button("Move to Desktop").disabled).toBe(true);
    expectNoMove();
    await act(async () => resolve({ localHosts: [] }));
    expect(document.querySelector('[aria-label="Source host connection"]')).toBeNull();
    expect(h.returnToDesktop).not.toHaveBeenCalled();
    await click(button("Move to Desktop"));
    expect(h.returnToDesktop).toHaveBeenCalledExactlyOnceWith(undefined);
  });
  it("lets a failed source check retry without starting or replacing an instance", async () => {
    h.connectedSource.mockRejectedValueOnce(new Error("The source server is unavailable"));
    await openReturn();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "source server is unavailable",
    );
    expectNoMove();
    await click(button(baseDictionary.chrome.apiDown.retry));
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(button("Move to Desktop").disabled).toBe(true);
    expect(h.connectedSource).toHaveBeenCalledTimes(2);
    expectNoMove();
  });
  it("selects the real server first, creates an account, and still requires explicit move confirmation", async () => {
    await openFreshMove();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Selected server");
    expect(h.post).not.toHaveBeenCalled();
    expectNoMove();
    await submitAccount();
    expect(h.post).toHaveBeenCalledExactlyOnceWith("system/upgrade-to-auth", {
      name: "Instance owner",
      email: "owner@example.test",
      password: "fixture-password-only",
      useOwnMailServer: false,
    });
    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe(
      copy.reviewMove,
    );
    expect(visible<HTMLInputElement>('input[aria-label="Instance address"]')[0]!.value).toBe(
      "ops.example.test",
    );
    expect(button("Move instance").disabled).toBe(true);
    expectNoMove();
    await click(visible<HTMLElement>('[role="checkbox"]')[0]!);
    await click(button("Move instance"));
    expect(h.preflight).toHaveBeenCalledOnce();
    expect(h.provision).toHaveBeenCalledExactlyOnceWith({
      serverId: "selected",
      access: "browser",
      domain: { kind: "custom", hostname: "ops.example.test" },
      mapping: undefined,
    });
    expect(h.move).not.toHaveBeenCalled();
  });
  it("keeps destination choices when going back from account setup", async () => {
    await openFreshMove();
    await click(button(copy.backToDestination));
    expect(visible<HTMLInputElement>('input[aria-label="Instance address"]')[0]!.value).toBe(
      "ops.example.test",
    );
    expect(
      document.querySelector('[aria-haspopup="listbox"][aria-label="Destination server"]')
        ?.textContent,
    ).toContain("Selected server");
    await click(button(copy.continueSetup));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Selected server");
    expect(h.post).not.toHaveBeenCalled();
    expectNoMove();
  });
  it("stays on account setup when creation fails and never starts a transfer", async () => {
    h.post.mockRejectedValueOnce(new Error("Account creation unavailable"));
    await openFreshMove();
    await submitAccount();
    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe(
      copy.secureAccount,
    );
    expect(h.toast).toHaveBeenCalledWith(
      "Account creation unavailable",
      "error",
      expect.any(String),
    );
    expectNoMove();
    await submitAccount();
    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe(
      copy.reviewMove,
    );
    expectNoMove();
  });
  it("does not ask an existing account to create another password", async () => {
    const state = { ...fresh, accountReady: true };
    h.status.mockResolvedValue(state);
    await render(<InstanceLocation initial={state} />);
    await click(button(copy.moveToServer));
    await chooseDestination();
    expect(button("Move instance").disabled).toBe(true);
    expect(visible('input[autocomplete="new-password"]')).toHaveLength(0);
    expect(h.post).not.toHaveBeenCalled();
    expectNoMove();
  });
  it("opens only destination setup from a feature shortcut", async () => {
    const opened = vi.fn();
    await render(<InstanceLocation moveRequested onMoveOpened={opened} />);
    expect(opened).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe(
      "Move your instance",
    );
    expect(visible('input[autocomplete="new-password"]')).toHaveLength(0);
    expect(h.post).not.toHaveBeenCalled();
    expectNoMove();
  });
  it("keeps a shortcut behind instance-admin access", async () => {
    h.status.mockRejectedValue(new ApiError(403, "Forbidden", {}));
    await render(<InstanceLocation moveRequested />);
    expect(document.body.textContent).toContain(copy.adminRequired);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expectNoMove();
  });
  it("does not open another move while one is in progress", async () => {
    const state: InstanceStatus = {
      ...fresh,
      role: "frozen",
      handoff: {
        id: "pending",
        direction: "source",
        status: "frozen",
        running: true,
        error: null,
        peerOrigin: "https://ops.example.test",
        provisioning: null,
      },
    };
    h.status.mockResolvedValue(state);
    await render(<InstanceLocation initial={state} moveRequested />);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expectNoMove();
  });
  it("offers pairing on the hosted instance and explains whose access is used", async () => {
    const state = { ...fresh, desktop: false, accountReady: true };
    h.status.mockResolvedValue(state);
    await render(<InstanceLocation initial={state} />);
    await click(button(copy.pairDesktop));
    expect(document.body.textContent).toContain(copy.pairOwnDevice);
    expect(h.pair).not.toHaveBeenCalled();
    await click(button("Create connection code"));
    expect(h.pair).toHaveBeenCalledOnce();
    expectNoMove();
  });
  it("does not offer an unreachable local Desktop as another Desktop's host", async () => {
    await render(<InstanceLocation initial={fresh} />);
    await click(document.querySelector<HTMLElement>(`[aria-label="${copy.moreOptions}"]`)!);
    expect(
      visible<HTMLButtonElement>("button").some(
        (node) => node.textContent?.trim() === copy.pairDesktop,
      ),
    ).toBe(false);
    expect(h.pair).not.toHaveBeenCalled();
  });
});

describe("feature prerequisites share the instance move", () => {
  it("gives Team one direct setup link, preserving its existing domain option", async () => {
    await render(
      <TeamReachabilityCard
        canMigrate
        reachability={{
          configured: false,
          url: null,
          source: null,
          selfAppInstalled: true,
          selfAppProjectId: "openship",
          selfAppHasDomain: false,
          selfAppHasVerifiedDomain: false,
        }}
      />,
    );
    expect(document.querySelectorAll(`a[href="${INSTANCE_MOVE_HREF}"]`)).toHaveLength(1);
    expect(document.querySelector('a[href="/projects/openship/domains"]')).not.toBeNull();
    expect(h.post).not.toHaveBeenCalled();
    expectNoMove();
  });
  it("asks members to contact their administrator, without a dead move button", async () => {
    await render(<TeamReachabilityCard canMigrate={false} reachability={null} />);
    expect(document.body.textContent).toContain(copy.adminRequired);
    expect(document.querySelector(`a[href="${INSTANCE_MOVE_HREF}"]`)).toBeNull();
    expect(document.querySelector("button[disabled]")).toBeNull();
  });
  it("does not ask a reachable instance to move before inviting", async () => {
    await render(
      <TeamReachabilityCard
        canMigrate
        reachability={{
          configured: true,
          url: "https://ops.example.test",
          source: "env",
          selfAppInstalled: false,
          selfAppProjectId: null,
          selfAppHasDomain: false,
          selfAppHasVerifiedDomain: false,
        }}
      />,
    );
    expect(host.textContent).toBe("");
  });
  it.each(["none", "repo", "app", "domain"])(
    "offers push-to-deploy setup only when reachability is missing (%s)",
    async (strategy) => {
      h.strategy = strategy;
      await render(<GitSettings />);
      expect(document.querySelectorAll(`a[href="${INSTANCE_MOVE_HREF}"]`)).toHaveLength(
        strategy === "none" ? 1 : 0,
      );
      expect(document.querySelector<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(
        strategy === "none",
      );
      expect(h.setAutoDeploy).not.toHaveBeenCalled();
      expectNoMove();
    },
  );
  it("does not offer to relocate the SaaS control plane", async () => {
    h.selfHosted = false;
    await render(<GitSettings />);
    expect(document.querySelector(`a[href="${INSTANCE_MOVE_HREF}"]`)).toBeNull();
    expectNoMove();
  });
});
