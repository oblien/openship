// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubProvider, type GitHubConnectionState } from "@/context/GitHubContext";
import { GitHubConnection } from "./GitHubConnection";
import { LibrarySidebar } from "../../library/components/LibrarySidebar";

const api = vi.hoisted(() => ({
  connect: vi.fn(),
  pollConnect: vi.fn(),
  getUserHome: vi.fn(),
  getStatusDeduped: vi.fn(),
  getStatus: vi.fn(),
  invalidateStatus: vi.fn(),
  showToast: vi.fn(),
  setInstanceToken: vi.fn(),
  disconnect: vi.fn(),
  showModal: vi.fn(),
  hideModal: vi.fn(),
  push: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  githubApi: api,
  settingsApi: { get: async () => ({}) },
  getApiErrorMessage: (error: Error) => error.message,
  GITHUB_SOURCES_CHANGED_EVENT: "github-sources-changed",
}));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: api.showToast }) }));
vi.mock("@/context/CloudContext", () => ({ useCloud: () => ({ connected: false }) }));
vi.mock("@/context/ModalContext", () => ({ useModal: () => ({ showModal: api.showModal, hideModal: api.hideModal }) }));
vi.mock("@/context/PlatformContext", () => ({
  usePlatform: () => ({ selfHosted: true, deployMode: "docker" }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: api.push }) }));

const disconnected: GitHubConnectionState = {
  primary: null,
  sources: {
    openshipApp: { connected: false },
    ghCli: { available: false, problem: "rejected", method: "device" },
  },
};
const connected: GitHubConnectionState = {
  primary: "gh-cli",
  sources: {
    openshipApp: { connected: false },
    ghCli: { available: true, login: "new-account", method: "device" },
  },
};
const deviceResponse = {
  connected: false,
  flow: "device_code",
  userCode: "ABCD-1234",
  verificationUri: "https://github.com/login/device",
  expiresIn: 899,
  interval: 5,
};
const capabilities = {
  platform: "selfhosted", desktop: false, primary: "device",
  methods: [
    { kind: "device", available: true, configured: true },
    { kind: "token", available: true, configured: false, credentialScope: "instance" },
    { kind: "app", available: true, configured: false, requiresCloud: true },
  ],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.connect.mockResolvedValue(deviceResponse);
  api.pollConnect.mockResolvedValue({ status: "pending" });
  api.getStatusDeduped.mockResolvedValue({ state: disconnected });
  api.getStatus.mockResolvedValue({ state: disconnected, capabilities });
  api.getUserHome.mockResolvedValue({ state: disconnected });
  api.setInstanceToken.mockResolvedValue({ connected: true, login: "new-account" });
  api.disconnect.mockResolvedValue({ success: true });
  api.showModal.mockReturnValue("disconnect-token");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function render(initialState = disconnected) {
  await act(async () => {
    root.render(
      <GitHubProvider initialData={{ state: initialState }}>
        <GitHubConnection />
      </GitHubProvider>,
    );
  });
}

async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find((el) =>
    el.textContent?.includes(label),
  );
  expect(button, `button: ${label}`).toBeDefined();
  await act(async () => button!.click());
}

function expectDeviceInstructions() {
  expect(container.textContent).toContain(deviceResponse.userCode);
  expect(container.querySelector('a[href="https://github.com/login/device"]')).not.toBeNull();
}

const appWithRejectedToken: GitHubConnectionState = {
  primary: "openship-app",
  sources: {
    openshipApp: { connected: true, login: "app-user", hasInstallations: true },
    ghCli: { available: false, method: "token", problem: "rejected" },
  },
};

async function enterToken(value: string) {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="GitHub token"]');
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Settings repairs the stored GitHub token (#944)", () => {
  beforeEach(() => {
    api.getStatusDeduped.mockResolvedValue({ state: appWithRejectedToken });
    api.getUserHome.mockResolvedValue({ state: appWithRejectedToken });
  });

  it("shows the rejected credential alongside the connected App and replaces it inline", async () => {
    await render(appWithRejectedToken);
    expect(container.textContent).toContain("GitHub rejected the stored GitHub token");
    expect(container.textContent).toContain("@app-user");
    await click("Replace GitHub token");
    await enterToken("ghp_replacement");
    const repaired = { ...appWithRejectedToken, sources: { ...appWithRejectedToken.sources, ghCli: { available: true, method: "token", login: "new-account" } } };
    api.getStatusDeduped.mockResolvedValue({ state: repaired });
    api.getUserHome.mockResolvedValue({ state: repaired });
    await click("Connect");
    expect(api.setInstanceToken).toHaveBeenCalledWith("ghp_replacement");
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.textContent).toContain("@new-account");
    expect(api.push).not.toHaveBeenCalled();
  });

  it("clears only the saved credential while the App remains connected", async () => {
    await render(appWithRejectedToken);
    await click("Clear saved token");
    const confirmation = api.showModal.mock.calls[0]![0];
    const clear = confirmation.buttons.find((button: { variant: string }) => button.variant === "danger");
    expect(clear).toBeDefined();
    const appOnly = { ...appWithRejectedToken, sources: { ...appWithRejectedToken.sources, ghCli: { available: false } } };
    api.getStatusDeduped.mockResolvedValue({ state: appOnly });
    api.getUserHome.mockResolvedValue({ state: appOnly });
    await act(async () => clear.onClick());
    expect(api.disconnect).toHaveBeenCalledExactlyOnceWith("cli");
    expect(container.textContent).toContain("@app-user");
    expect(container.textContent).not.toContain("Clear saved token");
  });

  it("opens a GitHub token field from Change method instead of the OpenShip API-token page", async () => {
    await render(appWithRejectedToken);
    await click("Change method");
    await click("Access token");
    expect(container.querySelector('input[aria-label="GitHub token"]')).not.toBeNull();
    expect(api.push).not.toHaveBeenCalled();
    await click("Cancel");
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.textContent).toContain("@app-user");
  });

  it("leaves a rejected replacement in the editor with the server's error", async () => {
    await render(appWithRejectedToken);
    await click("Replace GitHub token");
    await enterToken("ghp_invalid");
    api.setInstanceToken.mockRejectedValueOnce(new Error("GitHub rejected this replacement token"));
    await click("Connect");
    expect(container.textContent).toContain("GitHub rejected this replacement token");
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe("ghp_invalid");
    expect(api.disconnect).not.toHaveBeenCalled();
  });
});

describe("selecting a detected host CLI identity", () => {
  it("offers explicit CLI selection even with a connected Cloud App and no device client", async () => {
    const state: GitHubConnectionState = {
      primary: "openship-app",
      sources: {
        openshipApp: { connected: true, login: "app-user", hasInstallations: true },
        ghCli: { available: true, login: "operator", method: "host-cli" },
      },
    };
    const status = {
      state,
      capabilities: {
        ...capabilities,
        methods: capabilities.methods.map((method) => method.kind === "device"
          ? { ...method, available: false, configured: false } : method),
      },
    };
    api.getStatusDeduped.mockResolvedValue(status);
    api.getStatus.mockResolvedValue(status);
    api.getUserHome.mockResolvedValue({ state });
    api.connect.mockResolvedValue({ connected: true });
    await render(state);
    await click("Change method");
    expect(container.textContent).toContain("Use gh CLI");
    expect(container.textContent).toContain("Logged in as @operator");
    expect(container.textContent).not.toContain("Browser sign-in with a device code");
    expect(api.connect).not.toHaveBeenCalled();
    await click("Use gh CLI");
    expect(api.connect).toHaveBeenCalledExactlyOnceWith("cli");
    expect(api.push).not.toHaveBeenCalled();
  });

  it.each(["device", "token"] as const)("does not label a saved %s credential as a host CLI", async (method) => {
    const state: GitHubConnectionState = {
      ...connected,
      sources: { ...connected.sources, ghCli: { ...connected.sources.ghCli, method } },
    };
    api.getStatusDeduped.mockResolvedValue({ state, capabilities });
    await render(state);
    await click("Change method");
    expect(container.textContent).not.toContain("Use gh CLI");
    expect(api.connect).not.toHaveBeenCalled();
  });
});

describe("Library connection status after App fallback (#944)", () => {
  it("shows the App first and reuses the fallback status without another cloud request", async () => {
    await act(async () => root.render(
      <LibrarySidebar state={appWithRejectedToken} repos={[]} selectedOwner="acme" selfHosted cloudConnected />,
    ));
    const text = container.textContent!;
    expect(text.indexOf("GitHub App")).toBeLessThan(text.indexOf("GitHub token"));
    expect(text).not.toContain("@undefined");
    expect(text).not.toContain("Local library via gh CLI");
    expect(container.querySelector('a[href="/settings?tab=git"]')).not.toBeNull();
    expect(api.getStatusDeduped).not.toHaveBeenCalled();
  });

  it("does not invent a username when the token source has no login", async () => {
    const state: GitHubConnectionState = { ...connected, sources: { ...connected.sources, ghCli: { available: true, method: "token" } } };
    await act(async () => root.render(
      <LibrarySidebar state={state} repos={[]} selectedOwner="acme" selfHosted cloudConnected />,
    ));
    expect(container.textContent).not.toContain("@undefined");
    expect(container.textContent).toContain("GitHub token");
  });
});

describe("Settings GitHub device sign-in (#851)", () => {
  it("shows the returned code, copies it, and updates the card after polling completes", async () => {
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await render();
    await click("Sign in with GitHub");
    expectDeviceInstructions();
    await click(deviceResponse.userCode);
    expect(copy).toHaveBeenCalledWith(deviceResponse.userCode);

    api.pollConnect.mockResolvedValue({ status: "complete" });
    api.getStatusDeduped.mockResolvedValue({ state: connected });
    api.getUserHome.mockResolvedValue({ state: connected });
    await act(async () => vi.advanceTimersByTimeAsync(5000));

    expect(container.textContent).not.toContain(deviceResponse.userCode);
    expect(container.textContent).toContain("@new-account");
    expect(container.textContent).not.toContain("Sign in with GitHub");
    api.pollConnect.mockClear();
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(api.pollConnect).not.toHaveBeenCalled();
    copy.mockRestore();
  });

  it("keeps device instructions when switching from an already connected App", async () => {
    const appState: GitHubConnectionState = {
      ...disconnected,
      primary: "openship-app",
      sources: { ...disconnected.sources, openshipApp: { connected: true, login: "app-user" } },
    };
    api.getStatusDeduped.mockResolvedValue({ state: appState });
    api.getUserHome.mockResolvedValue({ state: appState });
    await render(appState);
    await click("Change method");
    await click("Sign in with GitHub");
    expectDeviceInstructions();
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expectDeviceInstructions();
  });

  it("does not let stale provider connectivity dismiss a new device grant", async () => {
    // The library provider can still have its initial verified identity while
    // the Settings card's fresh probe reports that credential as rejected.
    await render(connected);
    await click("Sign in with GitHub");
    expectDeviceInstructions();
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expectDeviceInstructions();
  });

  it("keeps the code visible while the card refreshes its status", async () => {
    await render();
    let resolveStatus!: (value: { state: GitHubConnectionState }) => void;
    api.getStatusDeduped.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
    );
    await click("Sign in with GitHub");
    await act(async () => window.dispatchEvent(new Event("github-sources-changed")));
    expectDeviceInstructions();
    await act(async () => resolveStatus({ state: disconnected }));
    expectDeviceInstructions();
  });

  it("returns to sign-in and surfaces the error when the device grant expires", async () => {
    await render();
    await click("Sign in with GitHub");
    api.pollConnect.mockResolvedValue({ status: "error", message: "The device code expired" });
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(container.textContent).not.toContain(deviceResponse.userCode);
    expect(container.textContent).toContain("Sign in with GitHub");
    expect(api.showToast).toHaveBeenCalledWith("The device code expired", "error", "GitHub");
  });
});
