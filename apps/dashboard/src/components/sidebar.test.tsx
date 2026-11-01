// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { baseDictionary } from "@/i18n";
import { issuesApi, type IssueCounts } from "@/lib/api/issues";
import { getActiveOrganizationId, setActiveOrganizationId } from "@/lib/api/client";
import { useIssueCounts } from "@/hooks/useIssueCounts";
import { Sidebar } from "./sidebar";
import { SidebarLayoutProvider, useSidebarCollapseRequest } from "@/context/SidebarLayoutContext";

const mocks = vi.hoisted(() => ({
  pathname: "/monitoring",
  widePlans: false,
  cloudConnected: false,
  summary: vi.fn(),
  feed: vi.fn(),
  organization: vi.fn(),
  projects: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    organization: {
      list: async () => ({ data: [] }),
      getFullOrganization: mocks.organization,
    },
  },
  signOut: vi.fn(),
}));
vi.mock("@/context/AuthContext", () => ({
  useAuth: () => ({ user: { id: "user-a", name: "Operator" } }),
}));
vi.mock("@/context/CloudContext", () => ({ useCloud: () => ({ connected: mocks.cloudConnected }) }));
vi.mock("@/context/PlatformContext", () => ({
  usePlatform: () => ({ selfHosted: true, deployMode: "docker", productView: "platform" }),
}));
vi.mock("@/context/MailScopeContext", () => ({ useMailScope: () => ({}) }));
vi.mock("@/components/mail-server-switcher", () => ({ MailServerSwitcher: () => null }));
vi.mock("@/components/theme-provider", () => ({
  useTheme: () => ({ resolvedTheme: "light", toggle: vi.fn() }),
}));
vi.mock("@/lib/api/client", async (original) => {
  const actual = await original<typeof import("@/lib/api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: (path: string) => {
        if (path === "issues/summary") return mocks.summary();
        if (path === "issues" || path === "issues?status=resolved") return mocks.feed(path);
        if (path === "projects/home") return mocks.projects();
        throw new Error(`Unexpected GET ${path}`);
      },
    },
  };
});

const counts: IssueCounts = { outage: 1, actionRequired: 2, advisory: 5, total: 8 };
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.pathname = "/monitoring";
  mocks.widePlans = false;
  mocks.cloudConnected = false;
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.organization.mockResolvedValue({ data: { id: "org-a" } });
  mocks.summary.mockResolvedValue({ data: counts });
  mocks.projects.mockResolvedValue({ success: true, projects: [] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setActiveOrganizationId(null);
});
function PlanLayoutRequest() {
  useSidebarCollapseRequest(mocks.pathname === "/billing/plans" && mocks.widePlans);
  return null;
}

it("shows Support last when the self-hosted account connects to Cloud, and removes it on disconnect", async () => {
  await render();
  expect(host.querySelector('a[href="/support"]')).toBeNull();
  mocks.cloudConnected = true;
  await render();
  const links = [...host.querySelectorAll('nav a[href]')];
  expect(links.at(-1)?.getAttribute("href")).toBe("/support");
  mocks.cloudConnected = false;
  await render();
  expect(host.querySelector('a[href="/support"]')).toBeNull();
});

it.each([
  { workspaceId: "managed-workspace" },
  { deployTarget: "cloud" },
  { source: "cloud" },
])("keeps Support reachable for an existing Cloud project when disconnected: %o", async (cloudProject) => {
  mocks.projects.mockResolvedValue({ success: true, projects: [{ id: "cloud-project", ...cloudProject }] });
  await render();
  expect(host.querySelector('nav a[href="/support"]')).not.toBeNull();
  expect(host.querySelector('nav a[href="/billing"]')).toBeNull();
  expect(mocks.projects).toHaveBeenCalledOnce();
});

async function render(props: ComponentProps<typeof Sidebar> = {}) {
  await act(async () =>
    root.render(
      <I18nProvider>
        <SidebarLayoutProvider>
          <Sidebar {...props} />
          <PlanLayoutRequest />
        </SidebarLayoutProvider>
      </I18nProvider>,
    ),
  );
}
const monitoring = () => host.querySelector<HTMLAnchorElement>('a[href="/monitoring"]')!;
const badge = () => monitoring().querySelector(".tabular-nums");
const sidebarToggle = () => host.querySelector<HTMLButtonElement>(
  'button[aria-controls="dashboard-sidebar"]',
)!;

async function navigate(pathname: string) {
  mocks.pathname = pathname;
  await render();
}

describe("Sidebar collapse", () => {
  it.each([
    ["/billing/plans", true],
    ["/billing/overview", true],
    ["/billing/usage", true],
  ])("opens %s with sidebar expanded=%s on direct entry", async (pathname, expanded) => {
    await navigate(pathname);
    expect(sidebarToggle().getAttribute("aria-expanded")).toBe(String(expanded));
  });

  it("temporarily collapses when opening plans from Home and starts each visit compact", async () => {
    mocks.widePlans = true;
    await navigate("/");
    expect(sidebarToggle().getAttribute("aria-expanded")).toBe("true");
    await navigate("/billing/plans");
    expect(sidebarToggle().getAttribute("aria-expanded")).toBe("false");
    await act(async () => sidebarToggle().click());
    await render();
    expect(sidebarToggle().getAttribute("aria-expanded")).toBe("true");
    await navigate("/billing/overview");
    expect(sidebarToggle().getAttribute("aria-expanded")).toBe("true");
    await navigate("/billing/plans");
    expect(sidebarToggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("restores a collapsed preference after manually expanding plans", async () => {
    mocks.widePlans = true;
    await navigate("/");
    await act(async () => sidebarToggle().click());
    expect(sidebarToggle().getAttribute("aria-expanded")).toBe("false");
    await navigate("/billing/plans");
    await act(async () => sidebarToggle().click());
    expect(sidebarToggle().getAttribute("aria-expanded")).toBe("true");
    await navigate("/projects");
    expect(sidebarToggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps temporary expansion separate between Scale and plans", async () => {
    mocks.widePlans = true;
    await navigate("/scale");
    await act(async () => sidebarToggle().click());
    expect(sidebarToggle().getAttribute("aria-expanded")).toBe("true");
    await navigate("/billing/plans");
    expect(sidebarToggle().getAttribute("aria-expanded")).toBe("false");
    await act(async () => sidebarToggle().click());
    await navigate("/scale");
    expect(sidebarToggle().getAttribute("aria-expanded")).toBe("false");
    await navigate("/");
    expect(sidebarToggle().getAttribute("aria-expanded")).toBe("true");
  });

  it("opens the mobile drawer fully without changing the desktop preference", async () => {
    mocks.widePlans = true;
    await navigate("/billing/plans");
    const onCloseMobile = vi.fn();
    await render({ mobileOpen: true, onCloseMobile });
    expect(sidebarToggle().getAttribute("aria-expanded")).toBe("true");
    await act(async () => sidebarToggle().click());
    expect(onCloseMobile).toHaveBeenCalledOnce();
    await render();
    expect(sidebarToggle().getAttribute("aria-expanded")).toBe("false");
    await navigate("/");
    expect(sidebarToggle().getAttribute("aria-expanded")).toBe("true");
  });

  it("waits for a wide comparison and preserves manual expansion when its layout changes", async () => {
    await navigate("/billing/plans");
    expect(sidebarToggle().getAttribute("aria-expanded")).toBe("true");
    mocks.widePlans = true;
    await render();
    expect(sidebarToggle().getAttribute("aria-expanded")).toBe("false");
    await act(async () => sidebarToggle().click());
    mocks.widePlans = false;
    await render();
    expect(sidebarToggle().getAttribute("aria-expanded")).toBe("true");
    mocks.widePlans = true;
    await render();
    expect(sidebarToggle().getAttribute("aria-expanded")).toBe("true");
  });
});

describe("Monitoring sidebar count", () => {
  it("keeps the distinct project total alongside actionable issues, excluding updates", async () => {
    mocks.projects.mockResolvedValue({
      success: true,
      projects: [{ id: "project-a" }, { id: "project-b", isApp: true }, { id: "project-a" }],
    });
    await render();
    expect(host.querySelector('a[href="/projects"] .tabular-nums')?.textContent).toBe("1");
    expect(badge()?.textContent).toBe("3");
    expect(monitoring().textContent).toContain(baseDictionary.dashboard.nav.issues);
    await act(async () => sidebarToggle().click());
    expect(monitoring().getAttribute("aria-label")).toBe("Monitoring: 3 issues");
    expect(badge()).toBeNull();
  });

  it("shows no count until the workspace and summary have loaded", async () => {
    let ready!: (result: { data: { id: string } }) => void;
    mocks.organization.mockReturnValue(
      new Promise((resolve) => {
        ready = resolve;
      }),
    );
    await render();
    expect(badge()).toBeNull();
    expect(mocks.summary).not.toHaveBeenCalled();
    await act(async () => ready({ data: { id: "org-a" } }));
    expect(badge()?.textContent).toBe("3");
  });

  it("hides the count when only updates remain and refreshes it as issues change", async () => {
    await render();
    mocks.summary.mockResolvedValueOnce({
      data: { outage: 0, actionRequired: 0, advisory: 5, total: 5 },
    });
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(badge()).toBeNull();
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(badge()?.textContent).toBe("3");
  });

  it("uses refreshed open-feed counts immediately and ignores resolved history", async () => {
    await render();
    mocks.feed.mockResolvedValueOnce({
      data: [],
      counts: { outage: 0, actionRequired: 1, advisory: 5, total: 6 },
      status: "open",
    });
    await act(async () => {
      await issuesApi.list();
    });
    expect(badge()?.textContent).toBe("1");
    mocks.feed.mockResolvedValueOnce({ data: [], counts, status: "resolved" });
    await act(async () => {
      await issuesApi.list("resolved");
    });
    expect(badge()?.textContent).toBe("1");
  });

  it("does not let an older summary replace the result of a completed repair", async () => {
    let finish!: (result: { data: IssueCounts }) => void;
    mocks.summary.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await render();
    mocks.feed.mockResolvedValueOnce({
      data: [],
      counts: { outage: 0, actionRequired: 0, advisory: 5, total: 5 },
      status: "open",
    });
    await act(async () => {
      await issuesApi.list();
    });
    await act(async () => finish({ data: counts }));
    expect(badge()).toBeNull();
  });

  it("retains known issues during a failed read and skips polling in a hidden tab", async () => {
    await render();
    mocks.summary.mockRejectedValueOnce(new Error("Offline"));
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(badge()?.textContent).toBe("3");
    const requests = mocks.summary.mock.calls.length;
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(mocks.summary).toHaveBeenCalledTimes(requests);
    visibility.mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(mocks.summary).toHaveBeenCalledTimes(requests + 1);
  });
});

function Count({ organizationId }: { organizationId: string | null | undefined }) {
  const result = useIssueCounts(organizationId);
  return <output>{result ? result.outage + result.actionRequired : "unknown"}</output>;
}
async function renderCount(organizationId: string | null | undefined) {
  setActiveOrganizationId(organizationId ?? null);
  await act(async () => root.render(<Count organizationId={organizationId} />));
}

describe("issue count lifecycle", () => {
  it("waits for workspace selection and rejects responses from the previous workspace", async () => {
    await renderCount(undefined);
    expect(host.textContent).toBe("unknown");
    expect(mocks.summary).not.toHaveBeenCalled();
    let finish!: (result: { data: IssueCounts }) => void;
    mocks.summary.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await renderCount("org-a");
    let finishFeed!: (result: object) => void;
    mocks.feed.mockReturnValueOnce(
      new Promise((resolve) => {
        finishFeed = resolve;
      }),
    );
    const oldFeed = issuesApi.list();
    mocks.summary.mockResolvedValueOnce({
      data: { outage: 0, actionRequired: 1, advisory: 0, total: 1 },
    });
    await renderCount("org-b");
    expect(getActiveOrganizationId()).toBe("org-b");
    expect(host.textContent).toBe("1");
    await act(async () => {
      finish({ data: counts });
      finishFeed({ data: [], counts, status: "open" });
      await oldFeed;
    });
    expect(host.textContent).toBe("1");
  });

  it("recovers from an initial failure, avoids overlapping reads, and stops when disabled", async () => {
    mocks.summary.mockRejectedValueOnce(new Error("Offline"));
    await renderCount(null);
    expect(host.textContent).toBe("unknown");
    let finish!: (result: { data: IssueCounts }) => void;
    mocks.summary.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mocks.summary).toHaveBeenCalledTimes(2);
    await act(async () => finish({ data: counts }));
    expect(host.textContent).toBe("3");
    await renderCount(undefined);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(mocks.summary).toHaveBeenCalledTimes(2);
    expect(host.textContent).toBe("unknown");
  });
});
