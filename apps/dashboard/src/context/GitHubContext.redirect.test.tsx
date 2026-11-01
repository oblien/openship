// @vitest-environment happy-dom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubProvider, useGitHub, type GitHubConnectionState } from "./GitHubContext";
import { GitHubConnection } from "@/app/(dashboard)/settings/_components/GitHubConnection";
import { useLibraryRepos } from "@/app/(dashboard)/library/useLibraryRepos";
import { ApiError } from "@/lib/api/client";
import { storeGitHubConnectError } from "@/lib/github-connect-error";

const h = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  getStatus: vi.fn(),
  getStatusDeduped: vi.fn(),
  getUserHome: vi.fn(),
  getUserRepos: vi.fn(),
  invalidateStatus: vi.fn(),
  showToast: vi.fn(),
  openWindow: vi.fn(),
  pollConnect: vi.fn(),
  claimInstallation: vi.fn(),
  platform: { selfHosted: false, deployMode: "cloud" },
}));

vi.mock("@/lib/api", () => ({
  githubApi: h,
  settingsApi: { get: async () => ({}) },
  getApiErrorMessage: (error: Error) => error.message,
  GITHUB_SOURCES_CHANGED_EVENT: "openship:github-sources-changed",
}));
vi.mock("@/utils/authWindow", () => ({ openAuthWindow: h.openWindow }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: h.showToast }) }));
vi.mock("@/context/CloudContext", () => ({ useCloud: () => ({ connected: true }) }));
vi.mock("@/context/ModalContext", () => ({ useModal: () => ({}) }));
vi.mock("@/context/PlatformContext", () => ({
  usePlatform: () => h.platform,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const disconnected: GitHubConnectionState = {
  primary: null,
  sources: { openshipApp: { connected: false }, ghCli: { available: false } },
};
const oauthOnly: GitHubConnectionState = {
  primary: "openship-app",
  sources: {
    openshipApp: { connected: true, login: "installer", hasInstallations: false },
    ghCli: { available: false },
  },
};
const installed: GitHubConnectionState = {
  ...oauthOnly,
  sources: {
    ...oauthOnly.sources,
    openshipApp: { ...oauthOnly.sources.openshipApp, hasInstallations: true },
  },
};
const cliOnly: GitHubConnectionState = {
  primary: "gh-cli",
  sources: {
    openshipApp: { connected: false },
    ghCli: { available: true, login: "operator", method: "host-cli" },
  },
};
const installedAccounts = [{ login: "connected-team", type: "Organization", source: "app" }];

let serverState: GitHubConnectionState;
let handle: {
  blocked: boolean;
  navigate: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
};
let returnedToApp: () => void;
let container: HTMLDivElement;
let root: Root | null;

function Probe() {
  const { connecting, connect, disconnect, refresh, state } = useGitHub();
  return (
    <>
      <button data-testid="connect" disabled={connecting} onClick={() => void connect("oauth")}>
        {connecting ? "Connecting GitHub" : "Connect GitHub"}
      </button>
      <button data-testid="refresh" onClick={() => void refresh()}>
        Refresh
      </button>
      <button data-testid="disconnect" onClick={() => void disconnect()}>
        Disconnect
      </button>
      <output data-testid="app-state">
        {state.sources.openshipApp.hasInstallations ? "installed" : "unavailable"}
      </output>
    </>
  );
}

function RepositoryProbe() {
  const { selectedOwner, connected } = useGitHub();
  const { repos } = useLibraryRepos(selectedOwner, connected);
  return <output data-testid="repos">{repos.map((repo) => repo.name).join(", ")}</output>;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  h.platform.selfHosted = false;
  h.platform.deployMode = "cloud";
  serverState = disconnected;
  returnedToApp = () => {};
  handle = {
    blocked: false,
    navigate: vi.fn(),
    close: vi.fn(),
    onClose: vi.fn((callback: () => void) => {
      returnedToApp = callback;
    }),
  };
  h.openWindow.mockReturnValue(handle);
  h.connect.mockResolvedValue({
    connected: false,
    flow: "redirect",
    step: "install",
    url: "https://github.com/apps/openship-io/installations/new?state=test-state",
    state: "test-state",
  });
  h.disconnect.mockResolvedValue({ success: true });
  h.pollConnect.mockResolvedValue({ status: "waiting" });
  h.claimInstallation.mockResolvedValue({ ok: true, installation: { id: 42, login: "connected-team" } });
  const status = async () => ({
    state: serverState,
    accounts: serverState.sources.openshipApp.hasInstallations ? installedAccounts : [],
    installUrl: "https://github.com/apps/openship-io/installations/new?state=expired-page-link",
  });
  h.getStatus.mockImplementation(status);
  h.getStatusDeduped.mockImplementation(status);
  h.getUserHome.mockImplementation(async () => ({ ...(await status()), repos: [] }));
  h.getUserRepos.mockResolvedValue({ data: [] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function render(initialState = disconnected, withRepositories = false) {
  await act(async () =>
    root!.render(
      <GitHubProvider initialData={{ state: initialState }}>
        <Probe />
        <GitHubConnection />
        {withRepositories && <RepositoryProbe />}
      </GitHubProvider>,
    ),
  );
}

async function start() {
  await render();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="connect"]')!.click(),
  );
  expect(connectButton().disabled).toBe(true);
}

function connectButton() {
  return container.querySelector<HTMLButtonElement>('[data-testid="connect"]')!;
}

async function advance(ms = 5000) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}

describe("GitHub redirect completion", () => {
  it("loads GitHub after mounting without server data and keeps the page usable while waiting", async () => {
    let complete!: (value: unknown) => void;
    h.getUserHome.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    await act(async () => root!.render(
      <StrictMode><GitHubProvider><Probe /></GitHubProvider></StrictMode>,
    ));
    expect(connectButton().disabled).toBe(false);
    expect(container.textContent).toContain("unavailable");
    expect(h.getUserHome).toHaveBeenCalledTimes(1);
    await act(async () => complete({ state: installed, accounts: installedAccounts, repos: [] }));
    expect(container.querySelector('[data-testid="app-state"]')?.textContent).toBe("installed");
    expect(h.getUserHome).toHaveBeenCalledTimes(1);
  });

  it("uses the App button on Cloud and keeps the personal-token alternative visible", async () => {
    await render();
    const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === "GitHub App");
    expect(button).toBeDefined();
    expect(container.textContent).toContain("Access token");
    await act(async () => button!.click());
    expect(h.connect).toHaveBeenCalledWith("oauth");
    expect(h.connect).not.toHaveBeenCalledWith("cli");
  });

  it("waits for this attempt even when an older installation is already connected", async () => {
    serverState = installed;
    h.connect.mockResolvedValue({ connected: false, flow: "redirect", completion: "attempt", state: "new-attempt", step: "install", url: "https://github.com/new-install" });
    await start();
    await advance();
    expect(connectButton().disabled).toBe(true);
    expect(h.pollConnect).toHaveBeenCalledWith("new-attempt");
    expect(h.getStatus).not.toHaveBeenCalled();
    expect(handle.close).not.toHaveBeenCalled();
    h.pollConnect.mockResolvedValue({ status: "complete" });
    await advance();
    expect(connectButton().disabled).toBe(false);
    expect(h.showToast).toHaveBeenCalledWith("GitHub connected", "success", "GitHub");
  });

  it("shows errors for the current attempt without consuming another popup's error", async () => {
    h.connect.mockResolvedValue({ connected: false, flow: "redirect", completion: "attempt", state: "current-attempt", step: "install", url: "https://github.com/new-install" });
    await start();
    storeGitHubConnectError("Other account cancelled", undefined, "other-attempt");
    await advance();
    expect(h.showToast).not.toHaveBeenCalled();
    storeGitHubConnectError("This connection was cancelled", undefined, "current-attempt");
    await advance();
    expect(connectButton().disabled).toBe(false);
    expect(h.showToast).toHaveBeenCalledWith("This connection was cancelled", "error", "GitHub");
  });

  it("lets the user select an existing installation with one claim and visible focus", async () => {
    h.connect.mockResolvedValue({
      connected: false,
      flow: "installations",
      state: "selection-attempt",
      installUrl: "https://github.com/install?state=selection-attempt",
      installations: [
        {
          id: 42,
          login: "connected-team",
          avatarUrl: "https://avatars.githubusercontent.com/u/42?v=4",
          type: "Organization",
          connected: false,
        },
      ],
    });
    let complete!: (result: unknown) => void;
    h.claimInstallation.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    await render();
    await act(async () => connectButton().click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(document.activeElement).toBe(dialog);
    const pick = [...dialog!.querySelectorAll("button")].find((button) => button.textContent?.includes("connected-team"))!;
    expect(pick.querySelector("img")?.getAttribute("src")).toBe(
      "https://avatars.githubusercontent.com/u/42?v=4",
    );
    await act(async () => { pick.click(); pick.click(); });
    expect(h.claimInstallation).toHaveBeenCalledExactlyOnceWith({ state: "selection-attempt", installationId: "42" });
    expect(pick.disabled).toBe(true);
    serverState = installed;
    await act(async () => complete({ ok: true, installation: { id: 42 } }));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain("connected-team");
    expect(h.showToast).toHaveBeenCalledWith("GitHub connected", "success", "GitHub");
  });

  it.each(["already-connected", "incomplete", "network"])("gives feedback for %s instead of silently closing the popup", async (caseName) => {
    if (caseName === "already-connected") h.connect.mockResolvedValue({ connected: true });
    if (caseName === "incomplete") h.connect.mockResolvedValue({ connected: false });
    if (caseName === "network") h.connect.mockRejectedValue(new TypeError("Failed to fetch"));
    await render();
    await act(async () => connectButton().click());
    expect(connectButton().disabled).toBe(false);
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(h.showToast).toHaveBeenCalledWith(expect.any(String), caseName === "already-connected" ? "success" : "error", "GitHub");
  });

  it("keeps a failed installation selection usable from the keyboard", async () => {
    h.connect.mockResolvedValue({ connected: false, flow: "installations", state: "selection-attempt", installUrl: "https://github.com/install?state=selection-attempt",
      installations: [{ id: 42, login: "connected-team", connected: false }] });
    h.claimInstallation.mockRejectedValueOnce(new Error("GitHub temporarily unavailable. Try again."));
    await render();
    await act(async () => connectButton().click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const pick = [...dialog.querySelectorAll("button")].find((button) => button.textContent?.includes("connected-team"))!;
    await act(async () => pick.click());
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("GitHub temporarily unavailable");
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(pick.disabled).toBe(false);
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("starts a fresh installation from Settings and refreshes the card only after completion", async () => {
    serverState = oauthOnly;
    await render();
    const reads = h.getStatusDeduped.mock.calls.length;
    const installButton = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.toLowerCase().includes("install"),
    );
    expect(installButton).toBeDefined();
    await act(async () => installButton!.click());

    expect(h.connect).toHaveBeenCalledWith("oauth");
    expect(handle.navigate).toHaveBeenCalledWith(
      "https://github.com/apps/openship-io/installations/new?state=test-state",
    );
    expect(h.getStatusDeduped).toHaveBeenCalledTimes(reads);
    serverState = installed;
    await advance();
    expect(container.textContent).toContain("connected-team");
    expect(h.getStatusDeduped).toHaveBeenCalledTimes(reads + 1);
  });

  it("finishes and refreshes Settings after installation even when the auth window never closes", async () => {
    await start();
    serverState = installed;
    await advance();

    expect(connectButton().disabled).toBe(false);
    expect(container.textContent).toContain("connected-team");
    expect(h.showToast).not.toHaveBeenCalled();
    h.getStatus.mockClear();
    h.getStatusDeduped.mockClear();
    await advance(20000);
    expect(h.getStatus).not.toHaveBeenCalled();
    expect(h.getStatusDeduped).not.toHaveBeenCalled();
  });

  it("does not mistake a CLI identity or OAuth without repository access for an installation", async () => {
    await start();
    serverState = cliOnly;
    await advance();
    expect(connectButton().disabled).toBe(true);
    serverState = oauthOnly;
    await advance();
    expect(connectButton().disabled).toBe(true);

    serverState = installed;
    await advance();
    expect(connectButton().disabled).toBe(false);
    expect(container.textContent).toContain("connected-team");
  });

  it("also refreshes the App card on desktop when library listing uses the local CLI", async () => {
    h.platform.selfHosted = true;
    h.platform.deployMode = "desktop";
    h.getUserHome.mockResolvedValue({ state: cliOnly, accounts: [], repos: [] });
    await start();
    serverState = installed;
    await advance();

    expect(connectButton().disabled).toBe(false);
    expect(container.textContent).toContain("connected-team");
  });

  it("still detects installation when focus or popup closure arrives before the callback commits", async () => {
    await start();
    await act(async () => returnedToApp());
    await advance();
    serverState = installed;
    await advance();

    expect(container.textContent).toContain("connected-team");
    expect(h.showToast).not.toHaveBeenCalled();
  });

  it("stops observing on unmount and ignores a status response that arrives afterwards", async () => {
    let resolveStatus!: (value: unknown) => void;
    await start();
    h.getStatus.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
    );
    await advance();
    await act(async () => {
      root!.unmount();
      root = null;
    });
    const homeCalls = h.getUserHome.mock.calls.length;
    expect(resolveStatus).toBeTypeOf("function");
    await act(async () => resolveStatus({ state: installed, accounts: installedAccounts }));
    await advance(10 * 60 * 1000);

    expect(h.getUserHome).toHaveBeenCalledTimes(homeCalls);
    expect(h.showToast).not.toHaveBeenCalled();
  });

  it("does not let a pre-install Settings response overwrite the verified connection", async () => {
    await start();
    let resolveOldStatus!: (value: unknown) => void;
    h.getStatusDeduped.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOldStatus = resolve;
        }),
    );
    await act(async () => window.dispatchEvent(new Event("openship:github-sources-changed")));
    serverState = installed;
    await advance();
    expect(container.textContent).toContain("connected-team");

    await act(async () => resolveOldStatus({ state: disconnected, accounts: [] }));
    expect(container.textContent).toContain("connected-team");
  });

  it("refreshes repositories after installation for an already authorized user and ignores the older empty list", async () => {
    serverState = oauthOnly;
    let resolveOldRepos!: (value: unknown) => void;
    h.getUserRepos.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOldRepos = resolve;
        }),
    );
    await render(oauthOnly, true);
    await act(async () => connectButton().click());
    h.getUserRepos.mockResolvedValue({ data: [{ id: 1, name: "newly-accessible-repo" }] });
    serverState = installed;
    await advance();

    expect(container.querySelector('[data-testid="repos"]')?.textContent).toBe(
      "newly-accessible-repo",
    );
    await act(async () => resolveOldRepos({ data: [] }));
    expect(container.querySelector('[data-testid="repos"]')?.textContent).toBe(
      "newly-accessible-repo",
    );
  });

  it("refreshes the library after installation even if a pre-install read is still pending", async () => {
    await start();
    let resolveOldHome!: (value: unknown) => void;
    h.getUserHome.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOldHome = resolve;
        }),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="refresh"]')!.click(),
    );
    serverState = installed;
    await advance();
    expect(container.querySelector('[data-testid="app-state"]')?.textContent).toBe("installed");

    await act(async () => resolveOldHome({ state: disconnected, accounts: [] }));
    expect(container.querySelector('[data-testid="app-state"]')?.textContent).toBe("installed");
  });

  it("retries transient status failures without overlapping requests", async () => {
    await start();
    let failRead!: (reason: unknown) => void;
    h.getStatus.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failRead = reject;
        }),
    );
    await advance(10000);
    expect(h.getStatus).toHaveBeenCalledTimes(1);
    expect(connectButton().disabled).toBe(true);
    await act(async () => failRead(new TypeError("Failed to fetch")));
    serverState = installed;
    await advance();

    expect(connectButton().disabled).toBe(false);
    expect(container.textContent).toContain("connected-team");
    expect(h.showToast).not.toHaveBeenCalled();
  });

  it("does not apply an earlier attempt's late status response to a new connection", async () => {
    await start();
    let resolveOldStatus!: (value: unknown) => void;
    h.getStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOldStatus = resolve;
        }),
    );
    await advance();
    await act(async () => returnedToApp());
    await act(async () => connectButton().click());
    expect(h.connect).toHaveBeenCalledTimes(2);
    await act(async () => resolveOldStatus({ state: installed, accounts: installedAccounts }));
    expect(connectButton().disabled).toBe(true);

    serverState = installed;
    await advance();
    expect(connectButton().disabled).toBe(false);
    expect(container.textContent).toContain("connected-team");
  });

  it("ends an unconfirmed attempt with the last server error and allows retry", async () => {
    await start();
    h.getStatus.mockRejectedValue(new Error("GitHub service is unavailable"));
    await advance(10 * 60 * 1000);

    expect(connectButton().disabled).toBe(false);
    expect(h.showToast).toHaveBeenCalledWith(
      expect.stringContaining("GitHub service is unavailable"),
      "error",
      "GitHub",
    );
    const reads = h.getStatus.mock.calls.length;
    await advance(20000);
    expect(h.getStatus).toHaveBeenCalledTimes(reads);
  });

  it("cancels pending installation observation when the user disconnects", async () => {
    await start();
    await advance();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="disconnect"]')!.click(),
    );
    const reads = h.getStatus.mock.calls.length;
    serverState = installed;
    await advance();

    expect(h.getStatus).toHaveBeenCalledTimes(reads);
    expect(connectButton().disabled).toBe(false);
    expect(container.querySelector('[data-testid="app-state"]')?.textContent).toBe("unavailable");
  });

  it("stops immediately and reports a rejected session instead of retrying for ten minutes", async () => {
    await start();
    h.getStatus.mockRejectedValue(
      new ApiError(401, "Unauthorized", { message: "Sign in again to finish connecting GitHub." }),
    );
    await advance();

    expect(connectButton().disabled).toBe(false);
    expect(h.showToast).toHaveBeenCalledWith(
      "Sign in again to finish connecting GitHub.",
      "error",
      "GitHub",
    );
    const reads = h.getStatus.mock.calls.length;
    await advance(20000);
    expect(h.getStatus).toHaveBeenCalledTimes(reads);
  });

  it("shows a callback error even when the browser refuses to close the callback page", async () => {
    await start();
    storeGitHubConnectError("account_already_linked_to_different_user");
    await advance();

    expect(connectButton().disabled).toBe(false);
    expect(h.showToast).toHaveBeenCalledWith(
      expect.stringContaining("already linked to a different Openship user"),
      "error",
      "GitHub",
    );
  });

  it("finishes an OAuth-only handoff on authorization without requiring an installation", async () => {
    h.connect.mockResolvedValue({
      connected: false,
      flow: "redirect",
      step: "oauth",
      url: "https://api.openship.io/api/cloud/github/oauth-bridge?token=test",
    });
    await start();
    serverState = oauthOnly;
    await advance();

    expect(connectButton().disabled).toBe(false);
    expect(h.showToast).not.toHaveBeenCalled();
  });
});
