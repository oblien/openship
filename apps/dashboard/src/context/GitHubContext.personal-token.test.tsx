// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubProvider, useGitHub, type GitHubConnectionState } from "./GitHubContext";
import { CloneCredentials } from "@/app/(dashboard)/settings/_components/CloneCredentials";
import { GitHubConnection } from "@/app/(dashboard)/settings/_components/GitHubConnection";
import { ConnectPrompt } from "@/app/(dashboard)/library/components/ConnectPrompt";
import { LibrarySidebar } from "@/app/(dashboard)/library/components/LibrarySidebar";
import { RepositoryList } from "@/app/(dashboard)/library/components/RepositoryList";
import { useLibraryRepos } from "@/app/(dashboard)/library/useLibraryRepos";
import { githubApi, GITHUB_SOURCES_CHANGED_EVENT } from "@/lib/api/github";
import { endpoints } from "@/lib/api/endpoints";

const h = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), showToast: vi.fn(), push: vi.fn() }));
vi.mock("@/lib/api/client", async (original) => {
  const client = await original<typeof import("@/lib/api/client")>();
  return { ...client, api: { ...client.api, get: h.get, patch: h.patch } };
});
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: h.showToast }) }));
vi.mock("@/context/CloudContext", () => ({ useCloud: () => ({ connected: true }) }));
vi.mock("@/context/ModalContext", () => ({ useModal: () => ({}) }));
vi.mock("@/context/PlatformContext", () => ({
  usePlatform: () => ({ selfHosted: false, deployMode: "cloud" }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));

const disconnected: GitHubConnectionState = {
  primary: null,
  sources: { openshipApp: { connected: false }, ghCli: { available: false } },
};
let credential: { hasToken: boolean; asDefault: boolean; setAt: string | null };
let login: string;
let rejected: boolean;
let repositoryOwner: string | null;
let extraOwners: string[];
let container: HTMLDivElement;
let root: Root;
const capabilities = {
  platform: "saas",
  desktop: false,
  primary: "app",
  methods: [
    { kind: "app", available: true },
    { kind: "token", available: true, credentialScope: "user" },
    { kind: "device", available: false },
    { kind: "forwarding", available: false },
  ],
};
function home() {
  const connected = credential.hasToken && credential.asDefault && !rejected;
  const owners = [repositoryOwner ?? login, ...extraOwners];
  return {
    state: connected
      ? {
          ...disconnected,
          primary: "personal-token",
          sources: { ...disconnected.sources, personalToken: { connected: true, login } },
        }
      : rejected
        ? {
            ...disconnected,
            sources: {
              ...disconnected.sources,
              personalToken: { connected: false, problem: "rejected" },
            },
          }
        : disconnected,
    accounts: connected
      ? [
          { login, source: "token", type: "User" },
          ...owners
            .filter((owner) => owner !== login)
            .map((owner) => ({ login: owner, source: "token", type: "Organization" })),
        ]
      : [],
    repos: connected
      ? owners.map((owner) => ({
          name: `${owner}-repo`,
          full_name: `${owner}/${owner}-repo`,
          owner,
          source: "token",
          private: true,
          updated_at: "2026-09-27T12:00:00Z",
        }))
      : [],
    capabilities,
  };
}

function Flow() {
  const ctx = useGitHub();
  const library = useLibraryRepos(ctx.selectedOwner, ctx.connected);
  return (
    <>
      <output data-testid="owner">{ctx.selectedOwner}</output>
      <output data-testid="repos">{library.repos.map((r) => r.name).join(",")}</output>
      <output data-testid="context-repos">{ctx.repos.map((r) => r.name).join(",")}</output>
      <button
        data-testid="read-owner"
        onClick={() => void ctx.fetchReposForOwner(ctx.selectedOwner)}
      >
        Read owner
      </button>
      <div data-testid="picker">
        <RepositoryList
          repos={ctx.repos}
          accounts={ctx.accounts}
          selectedOwner={ctx.selectedOwner}
          setSelectedOwner={ctx.setSelectedOwner}
          loading={ctx.loading}
          loadingRepos={ctx.loadingRepos}
          onInstall={() => void ctx.connect("oauth")}
          installing={ctx.connecting}
        />
      </div>
      {!ctx.connected && (
        <ConnectPrompt
          selfHosted={false}
          connecting={false}
          onConnect={ctx.connect}
          onRefresh={ctx.refresh}
          onBrowseApps={() => {}}
          cliAction={null}
        />
      )}
      <GitHubConnection />
      <CloneCredentials />
      <LibrarySidebar
        selectedOwner={ctx.selectedOwner}
        repos={library.repos}
        state={ctx.state}
        selfHosted={false}
        cloudConnected
      />
    </>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  githubApi.invalidateStatus();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  credential = { hasToken: false, asDefault: false, setAt: null };
  login = "alice";
  rejected = false;
  repositoryOwner = null;
  extraOwners = [];
  h.get.mockImplementation(async (url: string, options?: { params?: { owner?: string } }) => {
    if (url === endpoints.settings.get)
      return { cloneToken: { ...credential }, forwardGitToServer: false };
    if (url === endpoints.github.status || url === endpoints.github.userHome) return home();
    if (url === endpoints.github.userRepos) {
      const data = home().repos.filter((repo) => repo.owner === options?.params?.owner);
      return { data, total: data.length, count: data.length, totalPages: 1 };
    }
    throw new Error(`Unexpected GET ${url}`);
  });
  h.patch.mockImplementation(
    async (url: string, body: { token?: string | null; asDefault?: boolean }) => {
      expect(url).toBe(endpoints.settings.cloneCredentials);
      if (body.token === "ghp_bad") throw new Error("GitHub rejected this token");
      if (body.token === null) credential = { hasToken: false, asDefault: false, setAt: null };
      else if (body.token) {
        credential = {
          hasToken: true,
          asDefault: body.asDefault ?? (credential.hasToken ? credential.asDefault : true),
          setAt: "2026-09-27T12:00:00Z",
        };
        login = body.token.includes("bob") ? "bob" : "alice";
      } else if (body.asDefault !== undefined) credential.asDefault = body.asDefault;
      return { cloneToken: { ...credential } };
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  githubApi.invalidateStatus();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () =>
    root.render(
      <GitHubProvider initialData={{ state: disconnected, capabilities }}>
        <Flow />
      </GitHubProvider>,
    ),
  );
}
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text,
  );
  expect(button, text).toBeDefined();
  await act(async () => button!.click());
}
async function save(token = "ghp_alice") {
  const input = container.querySelector<HTMLInputElement>('input[type="password"]');
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, token);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    input!.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}

describe("Cloud personal-token onboarding", () => {
  it("uses the personal-token endpoint from the connection chooser and updates the library immediately", async () => {
    await render();
    const method = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Access token"));
    expect(method).toBeDefined();
    await act(async () => method!.click());
    const input = container.querySelector<HTMLInputElement>('input[aria-label="GitHub token"]');
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "ghp_alice");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const connect = [...input!.parentElement!.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Connect")!;
    await act(async () => connect.click());
    expect(h.patch).toHaveBeenCalledWith(endpoints.settings.cloneCredentials, { token: "ghp_alice", asDefault: true });
    expect(container.querySelector('[data-testid="repos"]')?.textContent).toBe("alice-repo");
    expect(container.textContent).toContain("@alice");
  });

  it("links alternative methods to Git settings and makes a saved token usable immediately", async () => {
    await render();
    expect(
      [...container.querySelectorAll("a")]
        .find((a) => a.textContent?.includes("Other connection methods"))
        ?.getAttribute("href"),
    ).toBe("/settings?tab=git");
    await save();
    expect(h.patch).toHaveBeenCalledWith(endpoints.settings.cloneCredentials, {
      token: "ghp_alice",
    });
    expect(container.querySelector('[data-testid="owner"]')?.textContent).toBe("alice");
    expect(container.querySelector('[data-testid="repos"]')?.textContent).toBe("alice-repo");
    expect(container.textContent).toContain("@alice");
    expect(container.textContent).not.toContain("Other connection methods");
    expect(container.textContent).not.toContain("Connected via Openship GitHub App");
  });

  it("switches the selected owner and repository list on replacement and removes access on clear", async () => {
    await render();
    await save();
    await click("Replace");
    await save("ghp_bob");
    expect(container.querySelector('[data-testid="owner"]')?.textContent).toBe("bob");
    expect(container.querySelector('[data-testid="repos"]')?.textContent).toBe("bob-repo");
    await click("Clear");
    expect(container.querySelector('[data-testid="owner"]')?.textContent).toBe("");
    expect(container.querySelector('[data-testid="repos"]')?.textContent).toBe("");
    expect(container.textContent).toContain("Other connection methods");
  });

  it("opens an accessible organization when a fine-grained token has no personal repositories", async () => {
    repositoryOwner = "team";
    await render();
    await save();
    expect(container.querySelector('[data-testid="owner"]')?.textContent).toBe("team");
    expect(container.querySelector('[data-testid="repos"]')?.textContent).toBe("team-repo");
  });

  it("keeps the project picker scoped to the selected owner after saving or refreshing a token", async () => {
    extraOwners = ["team"];
    await render();
    await save();
    const picker = () => container.querySelector('[data-testid="picker"]')!;
    expect(picker().textContent).toContain("alice-repo");
    expect(picker().textContent).not.toContain("team-repo");

    const team = [...picker().querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "team",
    )!;
    await act(async () => team.click());
    await act(async () => window.dispatchEvent(new Event(GITHUB_SOURCES_CHANGED_EVENT)));
    expect(container.querySelector('[data-testid="owner"]')?.textContent).toBe("team");
    expect(picker().textContent).toContain("team-repo");
    expect(picker().textContent).not.toContain("alice-repo");
  });

  it("refreshes every consumer on explicit disable/enable without clearing the saved token", async () => {
    await render();
    await save();
    const toggle = () =>
      container.querySelector<HTMLInputElement>(
        'input[type="checkbox"][aria-label="Use by default"]',
      )!;
    await act(async () => toggle().click());
    expect(credential.hasToken).toBe(true);
    expect(container.querySelector('[data-testid="repos"]')?.textContent).toBe("");
    await act(async () => toggle().click());
    expect(container.querySelector('[data-testid="repos"]')?.textContent).toBe("alice-repo");
  });

  it("keeps the connected account when replacement fails and shows the actual error", async () => {
    await render();
    await save();
    const event = vi.fn();
    window.addEventListener(GITHUB_SOURCES_CHANGED_EVENT, event);
    try {
      await click("Replace");
      await save("ghp_bad");
      expect(event).not.toHaveBeenCalled();
      expect(container.querySelector('[data-testid="owner"]')?.textContent).toBe("alice");
      expect(container.querySelector('[data-testid="repos"]')?.textContent).toBe("alice-repo");
      expect(h.showToast).toHaveBeenCalledWith(
        "GitHub rejected this token",
        "error",
        expect.any(String),
      );
    } finally {
      window.removeEventListener(GITHUB_SOURCES_CHANGED_EVENT, event);
    }
  });

  it("shows a rejected personal token as needing repair, with a recheck action", async () => {
    await render();
    await save();
    rejected = true;
    await act(async () => window.dispatchEvent(new Event(GITHUB_SOURCES_CHANGED_EVENT)));
    expect(container.textContent).toContain("GitHub rejected the stored GitHub token");
    expect(container.querySelector('[data-testid="repos"]')?.textContent).toBe("");
    expect(container.querySelector('a[href="https://github.com/settings/tokens"]')).not.toBeNull();
  });

  it("does not let an old owner request overwrite repositories after a token change", async () => {
    await render();
    await save();
    let finishOld!: (result: unknown) => void;
    h.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="read-owner"]')!.click(),
    );
    await click("Replace");
    await save("ghp_bob");
    await act(async () => finishOld({ data: [{ name: "old-alice-repo" }] }));
    expect(container.querySelector('[data-testid="context-repos"]')?.textContent).toBe("bob-repo");
    expect(container.querySelector('[data-testid="repos"]')?.textContent).toBe("bob-repo");
  });
});
