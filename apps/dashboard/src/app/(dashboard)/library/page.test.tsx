// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCredentialProvider } from "@repo/core";
import { credentialsApi } from "@/lib/api/credentials";
import { GitConnectionsProvider } from "@/context/GitContext";
import { LibraryContent } from "./LibraryContent";
import { decodeSlug } from "@/utils/repoSlug";
import { ApiError } from "@/lib/api/client";

const h = vi.hoisted(() => ({
  push: vi.fn(),
  connect: vi.fn(),
  selectOwner: vi.fn(),
  gitlabRepos: vi.fn(),
  connected: true,
  connecting: false,
  loading: false,
  selfHosted: false,
  appAvailable: true,
  requiresCloud: false,
  cloudConnected: true,
  href: "/library",
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: h.push }),
  usePathname: () => new URL(h.href, "https://app.test").pathname,
  useSearchParams: () => new URL(h.href, "https://app.test").searchParams,
}));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({
    data: { user: { id: "user" }, session: { activeOrganizationId: "org" } },
  }),
}));
vi.mock("@/context/PlatformContext", () => ({
  usePlatform: () => ({ selfHosted: h.selfHosted, deployMode: h.selfHosted ? "desktop" : "cloud" }),
}));
vi.mock("@/context/CloudContext", () => ({ useCloud: () => ({ connected: h.cloudConnected }) }));
vi.mock("@/context/GitHubContext", () => ({
  useGitHub: () => ({
    connected: h.connected,
    connecting: h.connecting,
    loading: h.loading,
    state: {
      primary: h.connected ? "personal-token" : null,
      sources: { openshipApp: { connected: false }, ghCli: { available: false } },
    },
    capabilities: {
      primary: "app",
      methods: [{ kind: "app", available: h.appAvailable, requiresCloud: h.requiresCloud }],
    },
    accounts: h.connected
      ? [
          { login: "alice", avatar_url: "" },
          { login: "acme", avatar_url: "" },
        ]
      : [],
    selectedOwner: h.connected ? "alice" : "",
    setSelectedOwner: h.selectOwner,
    connect: h.connect,
    refresh: vi.fn(),
    cliAction: null,
    installUrl: null,
  }),
}));
vi.mock("./useLibraryRepos", () => ({
  useLibraryRepos: () => ({
    repos: [],
    loading: false,
    search: "",
    visibility: "all",
    sort: "updated",
    setSearch: vi.fn(),
    setVisibility: vi.fn(),
    setSort: vi.fn(),
    setPage: vi.fn(),
    meta: { page: 1, totalPages: 1, total: 0, publicCount: 0, privateCount: 0, count: 0 },
  }),
}));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("@/components/HelpMenu", () => ({ HelpMenu: () => null }));
vi.mock("@/components/github/GitHubConnectionStatus", () => ({ GitHubConnectionStatus: () => null }));
vi.mock("@/lib/api/git", async (original) => ({
  ...(await original<typeof import("@/lib/api/git")>()),
  gitApi: () => ({ getUserRepos: h.gitlabRepos }),
}));
vi.mock("./components/LocalProjects", () => ({ LocalProjects: () => null }));
vi.mock("./components/FolderUpload", () => ({ FolderUpload: () => <div>Upload source folder</div> }));
vi.mock("@/components/apps/AppCatalog", () => ({ AppCatalog: () => <div>App catalog</div> }));
vi.mock("@/components/migration/PlatformMigrationWizard", () => ({
  PlatformMigrationWizard: ({ provider, onBack }: { provider: string; onBack: () => void }) => (
    <section aria-label={`${provider} import`}>
      <input aria-label="Connection name" />
      <button onClick={onBack}>Choose another source</button>
    </section>
  ),
}));
vi.mock("@/components/migration/ServerMigrationWizard", () => ({
  ServerMigrationWizard: ({ variant, onClose }: { variant: string; onClose: () => void }) => (
    <section aria-label="Migration" data-variant={variant}>
      <input aria-label="Source server" />
      <button onClick={onClose}>Close migration</button>
    </section>
  ),
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  h.gitlabRepos.mockResolvedValue({ data: [] });
  Object.assign(h, {
    connected: true,
    connecting: false,
    loading: false,
    selfHosted: false,
    appAvailable: true,
    requiresCloud: false,
    cloudConnected: true,
    href: "/library",
  });
  h.push.mockImplementation((href: string) => {
    if (href.split("?")[0] === "/library" || href.split("?")[0] === "/library/migrate") {
      h.href = href;
      root.render(<GitConnectionsProvider><LibraryContent /></GitConnectionsProvider>);
    }
  });
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const render = () => act(async () => root.render(<GitConnectionsProvider><LibraryContent /></GitConnectionsProvider>));
function button(label: string) {
  const result = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (node) => (node.getAttribute("aria-label") ?? node.textContent?.trim()) === label,
  );
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
const click = (label: string) => act(async () => button(label).click());
async function submitUrl(url: string) {
  const input = container.querySelector<HTMLInputElement>('input[type="url"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, url);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}

describe("New Project source actions", () => {
  it("opens the Cloud folder upload without connecting a Git provider", async () => {
    h.connected = false;
    await render();
    await click("Folder");
    expect(container.textContent).toContain("Upload source folder");
    expect(button("Folder").getAttribute("aria-pressed")).toBe("true");
    expect(h.connect).not.toHaveBeenCalled();
  });

  it("switches providers directly from the connection card and opens the selected provider's settings", async () => {
    await render();
    const sidebar = container.querySelector('aside[aria-label="Connection"]')!;
    const github = button("GitHub");
    const gitlab = button("GitLab");
    expect(sidebar.contains(github) && sidebar.contains(gitlab)).toBe(true);
    expect(github.getAttribute("aria-pressed")).toBe("true");
    await act(async () => gitlab.click());
    expect(gitlab.getAttribute("aria-pressed")).toBe("true");
    expect(github.getAttribute("aria-pressed")).toBe("false");
    expect(sidebar.querySelector("a")?.getAttribute("href")).toBe("/settings?tab=git&provider=gitlab");
    await click("Apps");
    expect(sidebar.querySelector("h2")?.textContent).toBe("Connection");
    expect(button("GitLab").getAttribute("aria-pressed")).toBe("true");
    expect(sidebar.querySelector("a")?.getAttribute("href")).toBe("/settings?tab=git&provider=gitlab");
    await click("GitHub");
    expect(container.textContent).toContain("App catalog");
    expect(sidebar.querySelector("a")?.getAttribute("href")).toBe("/settings?tab=git");
    await click("Repositories");
    expect(button("GitHub").getAttribute("aria-pressed")).toBe("true");
  });

  it("opens Apps from the disconnected prompt and transfers focus to its tab", async () => {
    h.connected = false;
    await render();
    await click("Deploy app");
    expect(container.textContent).toContain("App catalog");
    expect(button("Apps").getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(button("Apps"));
    expect(h.connect).not.toHaveBeenCalled();
  });

  it("keeps GitLab retry, credential entry and browsing apps available from the repository prompt", async () => {
    vi.spyOn(credentialsApi, "providers").mockResolvedValueOnce({
      data: [{ ...getCredentialProvider("gitlab")!, authorization: { available: true, hostCli: true } }],
    });
    h.gitlabRepos
      .mockRejectedValueOnce(new Error("GitLab is unavailable"))
      .mockRejectedValueOnce(new ApiError(409, "Conflict", { code: "GIT_CONNECTION_REQUIRED" }));
    await render();
    await click("GitLab");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("GitLab is unavailable");
    await click("Retry");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[data-illustration="git-authentication"]')).not.toBeNull();
    expect(container.textContent).toContain("Connect GitLab to deploy");
    await click("Connect GitLab");
    const modal = document.querySelector("[data-modal-surface]")!;
    expect(modal.querySelector("h2")?.textContent).toBe("Connect GitLab");
    const action = (label: string) => [...modal.querySelectorAll("button")].find((btn) => btn.textContent === label)!;
    expect(modal.querySelector('button[type="submit"]')?.textContent).toBe("Continue with GitLab");
    expect(modal.querySelector('input[type="password"]')).toBeNull();
    await act(async () => action("Use an access token").click());
    expect(document.activeElement).toBe(modal.querySelector('input[type="password"]'));
    const createToken = modal.querySelector<HTMLAnchorElement>('a[target="_blank"]')!;
    const url = new URL(createToken.href);
    expect(url.origin + url.pathname).toBe("https://gitlab.com/-/user_settings/personal_access_tokens");
    expect(url.searchParams.get("scopes")).toBe("read_api,read_repository");
    expect(url.searchParams.get("name")).toBe("OpenShip");
    expect(modal.textContent).toContain("also select api");
    await act(async () => action("Use GitLab CLI").click());
    expect(modal.textContent).toContain("glab auth login");
    expect(document.activeElement).toBe(modal.querySelector('button[type="submit"]'));
    const cancel = [...modal.querySelectorAll("button")].find((btn) => btn.textContent === "Cancel")!;
    await act(async () => cancel.click());
    await click("Deploy app");
    expect(document.activeElement).toBe(button("Apps"));
    expect(h.connect).not.toHaveBeenCalled();
  });

  it("submits explicit CLI consent and reloads GitLab repositories after linking", async () => {
    const provider = getCredentialProvider("gitlab")!;
    vi.spyOn(credentialsApi, "providers").mockResolvedValueOnce({
      data: [{ ...provider, authorization: { available: false, hostCli: true } }],
    });
    const connect = vi.spyOn(credentialsApi, "connectCli").mockResolvedValue({
      data: {
        id: "glab", name: "GitLab", provider: "gitlab", providerLabel: "GitLab",
        selector: null, publicFields: { authorization: "host-cli" }, secretsMasked: {},
        status: "active", lastVerifiedAt: null, lastError: null, createdAt: "", updatedAt: "",
      },
    });
    h.gitlabRepos.mockRejectedValueOnce(new ApiError(409, "Connect", { code: "GIT_CONNECTION_REQUIRED" }));
    await render();
    await click("GitLab");
    await click("Connect GitLab");
    const modal = document.querySelector("[data-modal-surface]")!;
    expect(modal.textContent).not.toContain("Continue with GitLab");
    const cli = [...modal.querySelectorAll("button")].find((button) => button.textContent === "Use GitLab CLI")!;
    await act(async () => cli.click());
    expect(connect).not.toHaveBeenCalled();
    await act(async () => modal.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    expect(connect).toHaveBeenCalledExactlyOnceWith({ provider: "gitlab", name: "GitLab" });
    expect(document.querySelector("[data-modal-surface]")).toBeNull();
    expect(h.gitlabRepos.mock.calls.length).toBeGreaterThan(1);
    expect(h.connect).not.toHaveBeenCalled();
  });

  it("opens token entry directly on an unconfigured SaaS and lets the user correct a rejected connection", async () => {
    vi.spyOn(credentialsApi, "providers").mockResolvedValueOnce({
      data: [{ ...getCredentialProvider("gitlab")!, authorization: { available: false } }],
    });
    const create = vi
      .spyOn(credentialsApi, "create")
      .mockRejectedValueOnce(new Error("A connection with this name already exists"))
      .mockResolvedValueOnce({
        data: {
          id: "second",
          name: "Work",
          provider: "gitlab",
          providerLabel: "GitLab",
          selector: null,
          publicFields: {},
          secretsMasked: {},
          status: "active",
          lastVerifiedAt: null,
          lastError: null,
          createdAt: "",
          updatedAt: "",
        },
      });
    h.gitlabRepos.mockRejectedValueOnce(
      new ApiError(409, "Connect", { code: "GIT_CONNECTION_REQUIRED" }),
    );
    await render();
    await click("GitLab");
    await click("Connect GitLab");
    const modal = document.querySelector("[data-modal-surface]")!;
    const submit = modal.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit.disabled).toBe(true);
    expect(modal.textContent).not.toContain("Continue with GitLab");
    expect(modal.textContent).not.toContain("Use GitLab CLI");
    const fill = (input: HTMLInputElement, value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    await fill(modal.querySelector<HTMLInputElement>('input[type="password"]')!, "test-token");
    await act(async () => submit.click());
    const payload = {
      provider: "gitlab",
      name: "GitLab",
      selector: null,
      values: { apiToken: "test-token" },
    };
    expect(create).toHaveBeenNthCalledWith(1, payload);
    expect(modal.querySelector('[role="alert"]')?.textContent).toContain("name already exists");
    const nameDisclosure = modal.querySelector("summary")!;
    expect(nameDisclosure.textContent).toBe("Connection name (optional)");
    expect(nameDisclosure.querySelector(".disclosure-chevron")).not.toBeNull();
    await act(async () => nameDisclosure.click());
    await fill(modal.querySelector<HTMLInputElement>("details input")!, "Work");
    await act(async () => submit.click());
    expect(create).toHaveBeenNthCalledWith(2, { ...payload, name: "Work" });
    expect(document.querySelector("[data-modal-surface]")).toBeNull();
  });

  it("completes SaaS browser authorization when GitLab isolates its popup", async () => {
    vi.useFakeTimers();
    const channel = new EventTarget();
    vi.stubGlobal("BroadcastChannel", class {
      addEventListener = channel.addEventListener.bind(channel);
      close() {}
    });
    vi.spyOn(credentialsApi, "providers").mockResolvedValueOnce({
      data: [{ ...getCredentialProvider("gitlab")!, authorization: { available: true } }],
    });
    const popup = {
      closed: false,
      close: vi.fn(),
      focus: vi.fn(),
      location: { href: "about:blank" },
    } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);
    const authorize = vi.spyOn(credentialsApi, "authorize").mockResolvedValue({
      state: "gitlab-state",
      url: "https://gitlab.com/oauth/authorize",
    });
    const list = vi.spyOn(credentialsApi, "list").mockResolvedValue({
      data: [
        {
          id: "connection",
          name: "GitLab",
          provider: "gitlab",
          providerLabel: "GitLab",
          selector: null,
          publicFields: { authorization: "oauth" },
          secretsMasked: {},
          status: "active",
          lastVerifiedAt: null,
          lastError: null,
          createdAt: "",
          updatedAt: "",
        },
      ],
    });
    h.gitlabRepos.mockRejectedValueOnce(
      new ApiError(409, "Connect", { code: "GIT_CONNECTION_REQUIRED" }),
    );
    await render();
    await click("GitLab");
    await click("Connect GitLab");
    const modal = document.querySelector("[data-modal-surface]")!;
    expect(modal.textContent).not.toContain("Use GitLab CLI");
    const primary = modal.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(primary.textContent).toBe("Continue with GitLab");
    await act(async () => primary.click());
    expect(authorize).toHaveBeenCalledExactlyOnceWith({ provider: "gitlab", name: "GitLab" });
    expect(popup.location.href).toBe("https://gitlab.com/oauth/authorize");
    Object.defineProperty(popup, "closed", { value: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(list).not.toHaveBeenCalled();
    const notify = (state: string) =>
      channel.dispatchEvent(new MessageEvent("message", { data: { type: "openship:connection", state } }));
    await act(async () => { notify("another-connection"); });
    expect(list).not.toHaveBeenCalled();
    await act(async () => { notify("gitlab-state"); });
    expect(list).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[data-modal-surface]")).toBeNull();
    expect(h.gitlabRepos.mock.calls.length).toBeGreaterThan(1);
  });

  it("finishes external browser authorization in the initiating Desktop session", async () => {
    const state = "desktop." + "a".repeat(43);
    type Result = import("@repo/core").DesktopConnectionCallback;
    let receive: ((result: Result) => void) | undefined;
    const openExternal = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("desktop", {
      isDesktop: true, onboarding: { openExternal },
      onConnectionCallback: (cb: (result: Result) => void) => {
        receive = cb;
        return () => { receive = undefined; };
      },
    });
    const popup = vi.spyOn(window, "open");
    vi.spyOn(credentialsApi, "providers").mockResolvedValue({
      data: [{ ...getCredentialProvider("gitlab")!, authorization: { available: true } }],
    });
    const url = "https://gitlab.com/oauth/authorize";
    const begin = vi.spyOn(credentialsApi, "authorize").mockResolvedValue({ state, url });
    const complete = vi.spyOn(credentialsApi, "completeAuthorization").mockResolvedValue({
      data: {
        id: "gitlab", provider: "gitlab", providerLabel: "GitLab", name: "GitLab", selector: null,
        publicFields: { authorization: "oauth" }, secretsMasked: {}, status: "active",
        lastVerifiedAt: null, lastError: null, createdAt: "", updatedAt: "",
      },
    });
    h.gitlabRepos.mockRejectedValueOnce(new ApiError(400, "Connect", { code: "GIT_CONNECTION_REQUIRED" }));
    await render();
    await click("GitLab");
    await click("Connect GitLab");
    const modal = document.querySelector("[data-modal-surface]")!;
    const alternate = (name: string) => [...modal.querySelectorAll("button")].find(button => button.textContent === name)!;
    await act(async () => alternate("Use an access token").click());
    await act(async () => alternate("Continue with GitLab").click());
    expect(begin).toHaveBeenCalledExactlyOnceWith({ provider: "gitlab", name: "GitLab", desktop: true });
    expect(popup).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(url);
    await act(async () => receive!({ state: "unrelated", code: "other" }));
    expect(complete).not.toHaveBeenCalled();
    await act(async () => {
      receive!({ state, code: "one-time" });
      receive!({ state, code: "one-time" });
    });
    expect(complete).toHaveBeenCalledExactlyOnceWith({ state, code: "one-time" });
    expect(document.querySelector("[data-modal-surface]")).toBeNull();
    expect(receive).toBeUndefined();
  });

  it("starts an observed connection without requiring a cached installation URL", async () => {
    await render();
    await click("Add GitHub account");
    expect(h.connect).toHaveBeenCalledExactlyOnceWith("oauth");
    expect(container.querySelector('a[href*="installations/new"]')).toBeNull();
    h.connecting = true;
    await render();
    expect(button("Add GitHub account").disabled).toBe(true);
    await click("Add GitHub account");
    expect(h.connect).toHaveBeenCalledTimes(1);
  });

  it("switches from the account row into URL import and back to the chosen owner", async () => {
    h.selfHosted = true;
    await render();
    await click("Import from Git URL");
    expect(container.querySelector('input[type="url"]')).not.toBeNull();
    expect(button("alice").getAttribute("aria-pressed")).toBe("false");
    expect(button("Import from Git URL").getAttribute("aria-pressed")).toBe("true");
    await click("acme");
    expect(h.selectOwner).toHaveBeenCalledWith("acme");
    expect(container.querySelector('input[type="url"]')).toBeNull();
    expect(container.querySelector('input[aria-label="Search repositories..."]')).not.toBeNull();
  });

  it("offers Git URL as a Cloud tab without repeating the account-row shortcut", async () => {
    await render();
    expect(container.querySelector('button[aria-label="Import from Git URL"]')).toBeNull();
    await click("Git URL");
    expect(button("Git URL").getAttribute("aria-pressed")).toBe("true");
    expect(button("Repositories").getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector('input[type="url"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Add GitHub account"]')).toBeNull();
    await click("Repositories");
    expect(container.querySelector('input[type="url"]')).toBeNull();
    expect(container.querySelector('input[aria-label="Search repositories..."]')).not.toBeNull();
    expect(h.selectOwner).not.toHaveBeenCalled();
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    "imports a public repository while disconnected, selfHosted=%s and loading=%s",
    async (selfHosted, loading) => {
      h.connected = false;
      h.selfHosted = selfHosted;
      h.loading = loading;
      await render();
      await click(selfHosted ? "Import from Git URL" : "Git URL");
      await submitUrl("https://github.com/alice/my.app.git");
      const path = h.push.mock.calls[0]?.[0] as string;
      expect(decodeSlug(path.split("/").at(-1)!)).toEqual({
        kind: "repo",
        owner: "alice",
        repo: "my.app",
      });
      expect(h.connect).not.toHaveBeenCalled();
    },
  );

  it("opens a GitLab subgroup URL in the deploy wizard without a GitHub connection", async () => {
    h.connected = false;
    await render();
    await click("Git URL");
    await submitUrl("https://gitlab.com/team/mobile/web.git");
    const path = h.push.mock.calls[0][0] as string;
    expect(decodeSlug(path.split("/").at(-1)!)).toEqual({
      kind: "repo", provider: "gitlab", owner: "team/mobile", repo: "web",
    });
  });

  it("rejects URLs outside registered providers", async () => {
    await render();
    await click("Git URL");
    await submitUrl("https://example.com/github.com/alice/app");
    expect(h.push).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "valid GitHub or GitLab repository URL",
    );
  });

  it("opens Git settings when a self-hosted App still needs setup", async () => {
    h.selfHosted = true;
    h.requiresCloud = true;
    h.cloudConnected = false;
    await render();
    await click("Add GitHub account");
    expect(h.push).toHaveBeenCalledExactlyOnceWith("/settings?tab=git");
    expect(h.connect).not.toHaveBeenCalled();
  });

  it("opens migration inline and keeps its progress mounted when switching tabs", async () => {
    h.selfHosted = true;
    await render();
    await click("Import existing project");
    expect(h.href).toBe("/library/migrate");
    expect(container.textContent).toContain("Where are you moving from?");
    const serverSource = Array.from(container.querySelectorAll("button")).find((node) =>
      node.textContent?.includes("Server or Docker"),
    );
    expect(serverSource).toBeDefined();
    await act(async () => serverSource!.click());
    expect(h.href).toBe("/library/migrate?from=server");
    const wizard = container.querySelector('[aria-label="Migration"]');
    expect(wizard?.getAttribute("data-variant")).toBe("tab");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await click("Apps");
    expect(h.href).toBe("/library");
    await click("Import existing project");
    expect(h.href).toBe("/library/migrate?from=server");
    expect(container.querySelector('[aria-label="Migration"]')).toBe(wizard);
    await click("Close migration");
    expect(h.href).toBe("/library");
    expect(container.querySelector('[aria-label="Migration"]')).toBeNull();
    expect(button("Repositories").getAttribute("aria-pressed")).toBe("true");
    expect(button("GitHub").getAttribute("aria-pressed")).toBe("true");
  });

  it.each(["railway", "vercel"])("opens a direct %s link without GitHub setup", async (provider) => {
    h.connected = false;
    h.loading = true;
    h.href = `/library/migrate?from=${provider}`;
    await render();
    expect(button("Import existing project").getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(`[aria-label="${provider} import"]`)).not.toBeNull();
    expect(h.connect).not.toHaveBeenCalled();
    const draft = container.querySelector<HTMLInputElement>('[aria-label="Connection name"]')!;
    draft.value = "My connection";
    await click("Apps");
    await click("Import existing project");
    expect(container.querySelector('[aria-label="Connection name"]')).toBe(draft);
    expect(draft.value).toBe("My connection");
    await click("Choose another source");
    expect(h.href).toBe("/library/migrate");
    expect(container.textContent).toContain("Where are you moving from?");
  });

  it("follows browser source navigation and resets provider-specific drafts", async () => {
    h.href = "/library/migrate?from=railway";
    await render();
    const railwayDraft = container.querySelector<HTMLInputElement>('[aria-label="Connection name"]')!;
    railwayDraft.value = "Railway connection";
    h.href = "/library/migrate?from=vercel";
    await render();
    expect(container.querySelector('[aria-label="railway import"]')).toBeNull();
    expect(container.querySelector('[aria-label="vercel import"]')).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>('[aria-label="Connection name"]')!.value).toBe("");
    h.href = "/library/migrate?from=railway";
    await render();
    expect(container.querySelector('[aria-label="railway import"]')).not.toBeNull();
    h.href = "/library/migrate";
    await render();
    expect(container.textContent).toContain("Where are you moving from?");
  });

  it.each(["", "?from=unknown", "?from=https%3A%2F%2Fevil.test", "?from=Railway"])(
    "shows the source chooser for an absent or unsupported hint (%s)", async (query) => {
      h.href = `/library/migrate${query}`;
      await render();
      expect(container.textContent).toContain("Where are you moving from?");
      expect(container.querySelector('[aria-label="Migration"]')).toBeNull();
      expect(container.querySelector('[aria-label="railway import"]')).toBeNull();
      expect(h.push).not.toHaveBeenCalled();
    },
  );
});
