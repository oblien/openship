// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubProvider, type GitHubConnectionState } from "@/context/GitHubContext";
import { GitHubConnection } from "./GitHubConnection";

const api = vi.hoisted(() => ({
  connect: vi.fn(),
  pollConnect: vi.fn(),
  getUserHome: vi.fn(),
  getStatusDeduped: vi.fn(),
  invalidateStatus: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  githubApi: api,
  settingsApi: { get: async () => ({}) },
  getApiErrorMessage: (error: Error) => error.message,
  GITHUB_SOURCES_CHANGED_EVENT: "github-sources-changed",
}));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: api.showToast }) }));
vi.mock("@/context/CloudContext", () => ({ useCloud: () => ({ connected: false }) }));
vi.mock("@/context/ModalContext", () => ({ useModal: () => ({}) }));
vi.mock("@/context/PlatformContext", () => ({
  usePlatform: () => ({ selfHosted: true, deployMode: "docker" }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

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

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.connect.mockResolvedValue(deviceResponse);
  api.pollConnect.mockResolvedValue({ status: "pending" });
  api.getStatusDeduped.mockResolvedValue({ state: disconnected });
  api.getUserHome.mockResolvedValue({ state: disconnected });
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
