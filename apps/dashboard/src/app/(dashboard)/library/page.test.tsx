// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryContent } from "./LibraryContent";
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
vi.mock("./components/LibrarySidebar", () => ({ LibrarySidebar: () => null }));
vi.mock("./components/LocalProjects", () => ({ LocalProjects: () => null }));
vi.mock("./components/FolderUpload", () => ({ FolderUpload: () => null }));
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
      root.render(<LibraryContent />);
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
  container.remove();
  vi.unstubAllGlobals();
});
const render = () => act(async () => root.render(<LibraryContent />));
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
