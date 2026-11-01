// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UseUpdates } from "./useUpdates";
const account = vi.hoisted(() => ({ key: "workspace-a", version: 0 }));
vi.mock("@/context/CloudResourceContext", () => ({ useCloudResourceKey: () => account.key }));
vi.mock("@/lib/api/client", () => ({ getApiRequestScopeVersion: () => account.version }));
const deployment = vi.hoisted(() => ({ selfHosted: true, version: "0.1.0" }));
vi.mock("@/hooks/useDeploymentInfo", () => ({
  useDeploymentInfo: () => deployment,
}));
vi.mock("@/lib/api/urls", () => ({ getRestApiBaseUrl: () => "http://localhost:4000/api" }));

const snapshot = {
  latest: { tag: "v99.0.0", version: "99.0.0", notes: "Product notes." },
  manifest: { advisories: [] },
};
const feed = vi.hoisted(() => ({
  check: vi.fn(),
  project: vi.fn(),
  security: null as unknown,
  overview: { projects: [], pendingProjects: 0, unknownProjects: 0 } as unknown,
}));
const check = feed.check;
vi.mock("@/lib/api/updates", () => ({
  updatesApi: {
    security: feed.project,
    advisories: () => {
      const { security, overview } = feed;
      return feed
        .check()
        .then((release: unknown) => ({ data: { release, security, overview, stale: false } }));
    },
  },
}));
const fetcher = vi.fn();
const persist = vi.fn();
const critical = {
  id: "critical-notice",
  severity: "critical" as const,
  announce: true,
  affects: ">=0.1.0",
  title: "Maintenance notice",
  message: "Review this notice.",
};
let root: Root;
let container: HTMLDivElement;
let useUpdates: () => UseUpdates;
let refreshSecurityAfterDeployment: typeof import("./useUpdates").refreshSecurityAfterDeployment;
const state: UseUpdates[] = [];
function Harness({ id }: { id: number }) {
  state[id] = useUpdates();
  return null;
}
async function mount() {
  await act(async () =>
    root.render(
      <>
        <Harness id={0} />
        <Harness id={1} />
      </>,
    ),
  );
}
const releaseRequests = () => fetcher.mock.calls.filter(([url]) => String(url).includes("github"));

beforeEach(async () => {
  vi.resetModules();
  deployment.selfHosted = true;
  account.key = "workspace-a";
  account.version = 0;
  feed.overview = { projects: [], pendingProjects: 0, unknownProjects: 0 };
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset().mockImplementation(async (url) => {
    if (String(url).endsWith("/latest"))
      return new Response(JSON.stringify({ tag_name: "v99.0.0" }));
    if (String(url).endsWith("CHANGELOG.md")) return new Response("## 99.0.0\n\nProduct notes.");
    return new Response(JSON.stringify({ advisories: [] }));
  });
  check.mockReset().mockResolvedValue({ available: false, ...snapshot });
  feed.project.mockReset();
  feed.security = null;
  persist.mockReset().mockResolvedValue(true);
  window.desktop = {
    isDesktop: true,
    app: { version: async () => "0.1.0" },
    config: {
      get: async (key: string) => (key === "lastSeenVersion" ? "0.1.0" : undefined),
      set: persist,
    },
    updates: { check },
  } as unknown as DesktopBridge;
  localStorage.clear();
  ({ useUpdates, refreshSecurityAfterDeployment } = await import("./useUpdates"));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

describe("advisory dismissal within an app session", () => {
  beforeEach(() => {
    check.mockResolvedValue({ ...snapshot, manifest: { advisories: [critical] } });
  });

  it("dismisses a critical notice in every consumer and keeps it dismissed after navigation and refresh", async () => {
    await mount();
    expect(state[0].state?.advisories).toEqual([critical]);
    expect(state[1].state?.advisories).toEqual([critical]);

    await act(async () => state[0].dismissAdvisory(critical.id));
    expect(state[0].state?.advisories).toEqual([]);
    expect(state[1].state?.advisories).toEqual([]);
    await act(async () => root.render(null));
    await mount();
    await act(async () => {
      state[0].refresh();
      state[1].reload();
    });
    expect(state[0].state?.advisories).toEqual([]);
    expect(state[1].state?.advisories).toEqual([]);
    expect(persist).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });

  it("does not resurrect a notice when an older in-flight load finishes", async () => {
    await mount();
    let finish!: (value: unknown) => void;
    check.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await act(async () => state[1].refresh());
    await act(async () => state[0].dismissAdvisory(critical.id));
    await act(async () => finish({ ...snapshot, manifest: { advisories: [critical] } }));
    expect(state[0].state?.advisories).toEqual([]);
    expect(state[1].state?.advisories).toEqual([]);
  });

  it("shows a new advisory and restores a critical notice in a new app session", async () => {
    await mount();
    await act(async () => state[0].dismissAdvisory(critical.id));
    const next = { ...critical, id: "new-critical-notice" };
    check.mockResolvedValue({ ...snapshot, manifest: { advisories: [critical, next] } });
    await act(async () => state[0].refresh());
    expect(state[0].state?.advisories).toEqual([next]);

    await act(async () => root.render(null));
    vi.resetModules();
    ({ useUpdates } = await import("./useUpdates"));
    await mount();
    expect(state[0].state?.advisories).toEqual([critical, next]);
  });

  it("also shares dismissal for operator notices in the cloud dashboard", async () => {
    delete window.desktop;
    deployment.selfHosted = false;
    // Every consumer receives its own readable response body.
    fetcher.mockImplementation(
      async () => new Response(JSON.stringify({ advisories: [critical] })),
    );
    await mount();
    expect(check).toHaveBeenCalledOnce();
    expect(state[0].state?.advisories).toEqual([critical]);
    await act(async () => state[0].dismissAdvisory(critical.id));
    await act(async () => state[1].reload());
    expect(state[0].state?.advisories).toEqual([]);
    expect(state[1].state?.advisories).toEqual([]);
    expect(localStorage.length).toBe(0);
  });

  it("keeps a noncritical dismissal for this session even if saving the preference fails", async () => {
    const recommended = { ...critical, severity: "recommended" as const };
    check.mockResolvedValue({ ...snapshot, manifest: { advisories: [recommended] } });
    persist.mockRejectedValue(new Error("Configuration store unavailable"));
    await mount();
    await act(async () => state[0].dismissAdvisory(recommended.id));
    await act(async () => state[1].reload());
    expect(state[0].state?.advisories).toEqual([]);
    expect(state[1].state?.advisories).toEqual([]);
    expect(persist).toHaveBeenCalledWith("dismissedAdvisoryIds", [recommended.id]);
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete window.desktop;
  vi.unstubAllGlobals();
});

describe("release check requests (#661)", () => {
  it.each(["desktop", "selfhosted", "cloud"])(
    "scopes signed control-plane advisories correctly in %s",
    async (mode) => {
      if (mode !== "desktop") delete window.desktop;
      deployment.selfHosted = mode !== "cloud";
      feed.security = {
        advisories: [
          {
            id: "control-plane-patch",
            revision: 1,
            title: "Update Openship",
            message: "Install the patched control plane.",
            severity: "high",
            url: "https://example.com/security",
            targets: [{ kind: "platform", affected: ">=0.0.0" }],
          },
        ],
      };
      await mount();
      if (mode === "cloud") {
        expect(check).toHaveBeenCalledOnce();
        expect(state[0].state?.updateAvailable).toBe(false);
        expect(state[0].state?.advisories).toEqual([]);
      } else {
        expect(check).toHaveBeenCalledOnce();
        expect(state[0].state?.advisories).toEqual([
          expect.objectContaining({ id: "security:control-plane-patch:1" }),
        ]);
      }
    },
  );

  it("uses one backend snapshot for multiple desktop consumers without a renderer GitHub fetch", async () => {
    await mount();
    expect(check).toHaveBeenCalledOnce();
    expect(releaseRequests()).toHaveLength(0);
    expect(state[0].latest).toEqual(snapshot.latest);
    expect(state[1].latest).toEqual(snapshot.latest);
  });

  it("refreshes through the shared backend check and uses that result", async () => {
    await mount();
    check.mockResolvedValueOnce({
      available: false,
      ...snapshot,
      latest: { ...snapshot.latest, version: "100.0.0" },
    });
    await act(async () => {
      state[0].refresh();
      state[1].refresh();
    });
    expect(check).toHaveBeenCalledTimes(2);
    expect(check).toHaveBeenLastCalledWith();
    expect(releaseRequests()).toHaveLength(0);
    expect(state[0].latest?.version).toBe("100.0.0");
  });

  it("also coalesces overlapping manual refreshes in the web dashboard", async () => {
    delete window.desktop;
    await mount();
    expect(check).toHaveBeenCalledTimes(1);
    expect(releaseRequests()).toHaveLength(0);
    await act(async () => {
      state[0].refresh();
      state[1].refresh();
    });
    expect(check).toHaveBeenCalledTimes(2);
    expect(releaseRequests()).toHaveLength(0);
  });
});

const affectedOverview = {
  projects: [
    {
      projectId: "app-a",
      name: "Private application",
      deploymentId: "deployed-a",
      findings: [
        {
          id: "runtime-fix",
          revision: 1,
          title: "Affected runtime",
          message: "Patch this runtime.",
          severity: "critical",
          url: "https://example.com/security",
          serviceId: "api",
          serviceName: "API",
          evidence: ["node 22.23.3"],
          canRefresh: true,
        },
      ],
    },
  ],
  pendingProjects: 0,
  unknownProjects: 0,
};
describe("global runtime advisories", () => {
  it.each([false, true])(
    "rechecks a completed deployment before clearing its banner (still affected: %s)",
    async (stillAffected) => {
      feed.overview = affectedOverview;
      await mount();
      const project = {
        ...affectedOverview.projects[0],
        deploymentId: "replacement",
        checkedAt: "2026-10-24T00:00:00Z",
        findings: stillAffected ? affectedOverview.projects[0].findings : [],
      };
      feed.project.mockImplementation(async () => {
        feed.overview = { ...affectedOverview, projects: [project] };
        return { data: project };
      });
      await act(async () =>
        Promise.all([
          refreshSecurityAfterDeployment(account.key, project.projectId, "replacement"),
          refreshSecurityAfterDeployment(account.key, project.projectId, "replacement"),
        ]),
      );
      expect(feed.project).toHaveBeenCalledExactlyOnceWith(project.projectId);
      expect(state[0].state?.advisories).toHaveLength(stillAffected ? 1 : 0);
      expect(state[1].securityOverview.projects[0].deploymentId).toBe("replacement");
      await act(async () =>
        refreshSecurityAfterDeployment(account.key, project.projectId, "replacement"),
      );
      expect(feed.project).toHaveBeenCalledOnce();
    },
  );

  it("keeps the warning when post-deploy verification fails or belongs to a different active deployment", async () => {
    feed.overview = affectedOverview;
    await mount();
    const project = affectedOverview.projects[0];
    feed.project.mockRejectedValueOnce(new Error("Unavailable"));
    await act(async () =>
      refreshSecurityAfterDeployment(account.key, project.projectId, "replacement"),
    );
    expect(state[0].state?.advisories).toHaveLength(1);
    feed.project.mockResolvedValueOnce({ data: project });
    await act(async () =>
      refreshSecurityAfterDeployment(account.key, project.projectId, "replacement"),
    );
    expect(state[0].state?.advisories).toHaveLength(1);
    expect(check).toHaveBeenCalledOnce();
  });
  it("ignores a late post-deploy check after switching accounts", async () => {
    feed.overview = affectedOverview;
    await mount();
    let resolveCheck!: (value: unknown) => void;
    feed.project.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCheck = resolve;
        }),
    );
    let pending!: Promise<void>;
    await act(async () => {
      pending = refreshSecurityAfterDeployment(account.key, "app-a", "replacement");
    });
    account.key = "workspace-b";
    account.version++;
    feed.overview = { projects: [], pendingProjects: 0, unknownProjects: 0 };
    await mount();
    const requests = check.mock.calls.length;
    await act(async () => {
      resolveCheck({
        data: { ...affectedOverview.projects[0], deploymentId: "replacement", findings: [] },
      });
      await pending;
    });
    expect(check).toHaveBeenCalledTimes(requests);
    expect(state[0].securityOverview.projects).toEqual([]);
    expect(state[1].runtimeAdvisories).toEqual([]);
  });

  it("keeps active findings in Monitoring after dismissal, refresh and navigation", async () => {
    feed.overview = affectedOverview;
    await mount();
    const id = state[0].runtimeAdvisories[0].id;
    await act(async () => state[0].dismissAdvisory(id));
    await act(async () => root.render(null));
    await mount();
    await act(async () => state[1].refresh());
    expect(state[0].state?.advisories).toEqual([]);
    expect(state[0].securityOverview).toEqual(affectedOverview);
    feed.overview = {
      ...affectedOverview,
      projects: affectedOverview.projects.map((p) => ({ ...p, findings: [] })),
    };
    await act(async () => state[0].refresh());
    expect(state[0].securityOverview.projects[0].findings).toEqual([]);
  });

  it("groups only the apps and service evidence belonging to each advisory", async () => {
    const project = affectedOverview.projects[0];
    const finding = project.findings[0];
    feed.overview = {
      ...affectedOverview,
      projects: [
        {
          ...project,
          findings: [finding, { ...finding, serviceId: "worker", serviceName: "Worker" }],
        },
        {
          ...project,
          projectId: "project-b",
          name: "Other app",
          findings: [{ ...finding, id: "another-fix" }],
        },
      ],
    };
    await mount();
    const notice = state[0].runtimeAdvisories.find((a) => a.id.endsWith(":runtime-fix:1"))!;
    expect(notice.projects.map((p) => p.projectId)).toEqual([project.projectId]);
    expect(notice.projects[0].findings.map((f) => f.serviceName)).toEqual(["API", "Worker"]);
    expect(project.findings).toHaveLength(1);
  });

  it("does not carry a runtime dismissal to another Cloud organization", async () => {
    feed.overview = affectedOverview;
    await mount();
    await act(async () => state[0].dismissAdvisory(state[0].runtimeAdvisories[0].id));
    account.key = "workspace-b";
    account.version++;
    await mount();
    expect(state[0].state?.advisories).toHaveLength(1);
  });
  it("refreshes the banner and settings together after consent changes", async () => {
    feed.overview = {
      ...affectedOverview,
      projects: affectedOverview.projects.map((p) => ({ ...p, autoRefresh: true })),
    };
    await mount();
    feed.overview = {
      ...affectedOverview,
      projects: affectedOverview.projects.map((p) => ({ ...p, autoRefresh: false, findings: [] })),
    };
    await act(async () => state[1].refresh());
    for (const consumer of state) {
      expect(consumer.securityOverview.projects[0].autoRefresh).toBe(false);
      expect(consumer.state?.advisories).toEqual([]);
    }
    expect(check).toHaveBeenCalledTimes(2);
  });
  it("does not reuse a read started before a consent mutation or let it overwrite the new result", async () => {
    delete window.desktop;
    feed.overview = {
      ...affectedOverview,
      projects: affectedOverview.projects.map((p) => ({ ...p, autoRefresh: true })),
    };
    await mount();
    let finish!: (value: unknown) => void;
    check.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await act(async () => state[0].refresh());
    feed.overview = {
      ...affectedOverview,
      projects: affectedOverview.projects.map((p) => ({ ...p, autoRefresh: false })),
    };
    await act(async () => state[1].refresh());
    for (const consumer of state)
      expect(consumer.securityOverview.projects[0].autoRefresh).toBe(false);
    await act(async () => finish(snapshot));
    for (const consumer of state)
      expect(consumer.securityOverview.projects[0].autoRefresh).toBe(false);
    expect(check).toHaveBeenCalledTimes(3);
  });
  it.each(["desktop", "selfhosted", "cloud"])(
    "shows workload findings through the root feed in %s",
    async (mode) => {
      if (mode !== "desktop") delete window.desktop;
      deployment.selfHosted = mode !== "cloud";
      feed.overview = affectedOverview;
      await mount();
      expect(state[0].state?.advisories).toEqual([
        expect.objectContaining({ title: "Affected runtime", severity: "critical" }),
      ]);
      expect(state[0].securityOverview).toEqual(affectedOverview);
      expect(state[0].runtimeAdvisories).toHaveLength(1);
      expect(check).toHaveBeenCalledOnce();
      expect(releaseRequests()).toHaveLength(0);
    },
  );
  it("does not cache or accept a late workload response across accounts", async () => {
    feed.overview = affectedOverview;
    let finish!: (value: unknown) => void;
    check.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await mount();
    account.key = "workspace-b";
    account.version++;
    feed.overview = { projects: [], pendingProjects: 0, unknownProjects: 0 };
    await mount();
    expect(state[0].securityOverview.projects).toEqual([]);
    await act(async () => finish(snapshot));
    expect(state[0].securityOverview.projects).toEqual([]);
    expect(state[0].state?.advisories).toEqual([]);
    expect(check).toHaveBeenCalledTimes(2);
  });
  it("clears displayed workload findings immediately on account changes", async () => {
    feed.overview = affectedOverview;
    await mount();
    expect(state[0].securityOverview.projects).toHaveLength(1);
    account.key = "workspace-b";
    account.version++;
    check.mockReturnValue(new Promise(() => {}));
    await mount();
    expect(state[0].securityOverview.projects).toEqual([]);
    expect(state[0].state).toBeNull();
  });
  it("retains a warning offline while disabling refresh actions", async () => {
    feed.overview = affectedOverview;
    await mount();
    check.mockRejectedValueOnce(new Error("offline"));
    await act(async () => state[0].refresh());
    expect(state[0].state?.advisories).toHaveLength(1);
    expect(state[0].securityOverview.projects[0]).toMatchObject({
      feedStale: true,
      findings: [expect.objectContaining({ canRefresh: false })],
    });
  });
});
