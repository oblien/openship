// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubProvider, useGitHub, type GitHubConnectionState } from "./GitHubContext";
import { useLibraryRepos } from "@/app/(dashboard)/library/useLibraryRepos";

const h = vi.hoisted(() => ({
  getUserHome: vi.fn(),
  getUserRepos: vi.fn(),
  invalidateStatus: vi.fn(),
  showToast: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  githubApi: h,
  settingsApi: {},
  GITHUB_SOURCES_CHANGED_EVENT: "openship:github-sources-changed",
}));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: h.showToast }) }));

const state: GitHubConnectionState = {
  primary: "personal-token",
  sources: {
    openshipApp: { connected: true, login: "member", hasInstallations: true },
    ghCli: { available: false },
    personalToken: { connected: true, login: "member" },
  },
};
const repository = (name: string) => ({
  name,
  full_name: `workspace-owner/${name}`,
  owner: "workspace-owner",
  source: "app" as const,
});
let visibleRepos: ReturnType<typeof repository>[];
let visibility: DocumentVisibilityState;
let container: HTMLDivElement;
let root: Root | null;

function home() {
  return {
    state,
    accounts: visibleRepos.length
      ? [{ login: "workspace-owner", type: "User", source: "app" }]
      : [],
    repos: visibleRepos,
  };
}

function Probe() {
  const github = useGitHub();
  const library = useLibraryRepos(github.selectedOwner, github.connected);
  return (
    <>
      <output data-testid="owner">{github.selectedOwner}</output>
      <output data-testid="repos">{library.repos.map((repo) => repo.name).join(",")}</output>
      <output data-testid="count">{library.meta.count}</output>
    </>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  visibleRepos = [];
  h.getUserHome.mockImplementation(async () => home());
  h.getUserRepos.mockImplementation(async (owner: string) => {
    const data = visibleRepos.filter((repo) => repo.owner === owner);
    return { data, count: data.length, total: data.length, totalPages: 1 };
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () =>
    root!.render(
      <GitHubProvider initialData={home()}>
        <Probe />
      </GitHubProvider>,
    ),
  );
}
const value = (id: string) => container.querySelector(`[data-testid="${id}"]`)?.textContent;
async function returnToTab() {
  await act(async () => {
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(150);
  });
}

describe("GitHub access changes in another session", () => {
  it("shows newly granted workspace repos instead of retaining the member's personal login", async () => {
    await render();
    expect(value("owner")).toBe("member");
    expect(value("repos")).toBe("");
    expect(h.getUserHome).not.toHaveBeenCalled();

    visibleRepos = [repository("shared-app")];
    await returnToTab();

    expect(h.getUserHome).toHaveBeenCalledTimes(1);
    expect(value("owner")).toBe("workspace-owner");
    expect(value("repos")).toBe("shared-app");
    expect(value("count")).toBe("1");
  });

  it("updates the paginated list when grants change without changing the selected owner", async () => {
    visibleRepos = [repository("first-app")];
    await render();
    expect(value("repos")).toBe("first-app");

    visibleRepos = [repository("first-app"), repository("second-app")];
    await returnToTab();
    expect(value("owner")).toBe("workspace-owner");
    expect(value("repos")).toBe("first-app,second-app");
    expect(value("count")).toBe("2");

    visibleRepos = [repository("second-app")];
    await returnToTab();
    expect(value("repos")).toBe("second-app");
    expect(value("count")).toBe("1");
  });

  it("rechecks a focused window but avoids background fetches and cancels queued work on unmount", async () => {
    await render();
    await act(async () => {
      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(h.getUserHome).not.toHaveBeenCalled();

    await act(async () => {
      visibility = "visible";
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(h.getUserHome).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      root!.unmount();
      root = null;
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(h.getUserHome).toHaveBeenCalledTimes(1);
  });
});
