// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LibraryPage from "./page";
import { decodeSlug } from "@/utils/repoSlug";

const h = vi.hoisted(() => ({
  push: vi.fn(),
  connect: vi.fn(),
  selectOwner: vi.fn(),
  connected: true,
  connecting: false,
  loading: false,
  selfHosted: false,
  appAvailable: true,
  requiresCloud: false,
  cloudConnected: true,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));
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
vi.mock("./components/LibrarySidebar", () => ({ LibrarySidebar: () => null }));
vi.mock("./components/LocalProjects", () => ({ LocalProjects: () => null }));
vi.mock("./components/FolderUpload", () => ({ FolderUpload: () => null }));
vi.mock("@/components/apps/AppCatalog", () => ({ AppCatalog: () => <div>App catalog</div> }));
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
  Object.assign(h, {
    connected: true,
    connecting: false,
    loading: false,
    selfHosted: false,
    appAvailable: true,
    requiresCloud: false,
    cloudConnected: true,
  });
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const render = () => act(async () => root.render(<LibraryPage />));
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
  it("opens Apps from the disconnected prompt and transfers focus to its tab", async () => {
    h.connected = false;
    await render();
    await click("Deploy app");
    expect(container.textContent).toContain("App catalog");
    expect(button("Apps").getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(button("Apps"));
    expect(h.connect).not.toHaveBeenCalled();
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
    expect(button("GitHub").getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector('input[type="url"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Add GitHub account"]')).toBeNull();
    await click("GitHub");
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

  it("rejects URLs outside GitHub instead of importing a matching substring", async () => {
    await render();
    await click("Git URL");
    await submitUrl("https://example.com/github.com/alice/app");
    expect(h.push).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "valid GitHub repository URL",
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
    const wizard = container.querySelector('[aria-label="Migration"]');
    expect(wizard?.getAttribute("data-variant")).toBe("tab");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await click("Apps");
    await click("Import existing project");
    expect(container.querySelector('[aria-label="Migration"]')).toBe(wizard);
    await click("Close migration");
    expect(container.querySelector('[aria-label="Migration"]')).toBeNull();
    expect(button("GitHub").getAttribute("aria-pressed")).toBe("true");
  });
});
