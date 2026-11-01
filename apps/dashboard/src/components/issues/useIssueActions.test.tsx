// @vitest-environment happy-dom
import { act, useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  apply: vi.fn(),
  status: vi.fn(),
  toast: vi.fn(),
  feed: vi.fn(),
  infra: vi.fn(),
}));
vi.mock("@/lib/api/issues", async (original) => ({
  ...(await original<typeof import("@/lib/api/issues")>()),
  runResolution: h.apply,
}));
vi.mock("@/lib/api/deploy", () => ({ deployApi: { getBuildStatus: h.status } }));
vi.mock("@/components/toast", () => ({ useToast: () => ({ toast: h.toast }) }));
vi.mock("@/hooks/useInfraFix", () => ({ useInfraFix: () => h.infra }));

import { setActiveOrganizationId } from "@/lib/api/client";
import type { SystemIssue } from "@/lib/api/issues";
import { I18nProvider } from "@/components/i18n-provider";
import { UpdatesCard } from "@/components/overview/AttentionCards";
import { IssueList } from "./IssueList";
import { useIssueActions } from "./useIssueActions";

const issue: SystemIssue = {
  id: "update:proj_mongo",
  kind: "update_available",
  severity: "advisory",
  scope: "project",
  source: "update",
  title: "MongoDB",
  message: "7.0 → 7.0",
  details: { kind: "image", latestInProgress: false },
  target: { scope: "project", id: "proj_mongo", name: "MongoDB", href: "/projects/proj_mongo" },
  resolveWith: [{ label: "Update", method: "POST", path: "/api/updates/proj_mongo/apply" }],
};
const updating = {
  ...issue,
  details: { latestInProgress: true, inProgressDeploymentId: "dep_update" },
};
const accepted = { data: { success: true, deployment_id: "dep_update", project_id: "proj_mongo" } };
const running = { status: "building", deploymentStatus: "building" };
const ready = { status: "ready", deploymentStatus: "ready", completionPending: false };
let root: Root;
let element: HTMLDivElement;
let actions: ReturnType<typeof useIssueActions>;
let replaceFeed: (rows: SystemIssue[]) => void;
function Harness({
  surface = "card",
  initial = [issue],
}: {
  surface?: "card" | "page";
  initial?: SystemIssue[];
}) {
  const [rows, setRows] = useState(initial);
  replaceFeed = setRows;
  const reload = useCallback(async () => {
    setRows(await h.feed());
  }, []);
  actions = useIssueActions(reload, undefined, rows);
  const props = {
    issues: actions.issues,
    busyIds: actions.busyIds,
    onResolve: actions.resolve,
    onInfraFix: actions.infraFix,
  };
  return surface === "card" ? <UpdatesCard {...props} /> : <IssueList {...props} />;
}
async function render(surface: "card" | "page" = "card", initial?: SystemIssue[]) {
  await act(async () =>
    root.render(
      <I18nProvider>
        <Harness surface={surface} initial={initial} />
      </I18nProvider>,
    ),
  );
}
const button = () => element.querySelector<HTMLButtonElement>("button[aria-busy]");
async function tick(ms = 5_000) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setActiveOrganizationId("org_a");
  for (const fn of Object.values(h)) fn.mockReset();
  h.apply.mockResolvedValue(accepted);
  h.status.mockResolvedValue(running);
  h.feed.mockResolvedValue([]);
  element = document.createElement("div");
  document.body.appendChild(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(["card", "page"] as const)("%s update progress", (surface) => {
  it("stays Updating after enqueue, through deployment and cleanup, then refreshes once", async () => {
    await render(surface);
    await act(async () => button()!.click());
    expect(button()!.disabled).toBe(true);
    expect(button()!.textContent).toBe("Updating…");
    expect(h.toast).not.toHaveBeenCalled();
    expect(h.feed).not.toHaveBeenCalled();
    h.status.mockResolvedValue({ status: "deploying", deploymentStatus: "deploying" });
    await tick();
    h.status.mockResolvedValue({ ...ready, completionPending: true });
    await tick();
    expect(button()!.disabled).toBe(true);
    expect(h.toast).not.toHaveBeenCalled();
    await act(async () => button()!.click());
    expect(h.apply).toHaveBeenCalledTimes(1);
    h.status.mockResolvedValue(ready);
    await tick();
    expect(h.toast).toHaveBeenCalledExactlyOnceWith("success", "Done", "Monitoring");
    expect(h.feed).toHaveBeenCalledTimes(1);
    expect(button()).toBeNull();
    const reads = h.status.mock.calls.length;
    await tick(60_000);
    expect(h.status).toHaveBeenCalledTimes(reads);
  });

  it("recovers an update started elsewhere from the feed after a refresh", async () => {
    await render(surface, [updating]);
    expect(button()!.disabled).toBe(true);
    expect(button()!.textContent).toBe("Updating…");
    await act(async () => actions.resolve(updating));
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.status).toHaveBeenCalledWith(
      "dep_update",
      expect.objectContaining({ headers: { "X-Organization-Id": "org_a" } }),
    );
    h.status.mockResolvedValue(ready);
    await tick();
    expect(button()).toBeNull();
    expect(h.toast).not.toHaveBeenCalled(); // no repeated success toast on navigation
  });
});

it("guards two submissions in the same React turn", async () => {
  const request = deferred<typeof accepted>();
  h.apply.mockReturnValue(request.promise);
  await render();
  await act(async () => {
    void actions.resolve(issue);
    void actions.resolve(issue);
  });
  expect(h.apply).toHaveBeenCalledTimes(1);
  expect(button()!.disabled).toBe(true);
  await act(async () => request.resolve(accepted));
  expect(button()!.disabled).toBe(true);
  expect(h.toast).not.toHaveBeenCalled();
});

it("allows another project to update while keeping each project's action locked", async () => {
  const other: SystemIssue = {
    ...issue,
    id: "update:proj_other",
    title: "Other app",
    target: { ...issue.target, id: "proj_other" },
    resolveWith: [{ ...issue.resolveWith[0]!, path: "/api/updates/proj_other/apply" }],
  };
  h.apply.mockImplementation(async (fix) => ({
    data: {
      deployment_id: fix.path.includes("proj_other") ? "dep_other" : "dep_update",
      project_id: fix.path.includes("proj_other") ? "proj_other" : "proj_mongo",
    },
  }));
  await render("page", [issue, other]);
  await act(async () => {
    await actions.resolve(issue);
    await actions.resolve(other);
  });
  expect(h.apply).toHaveBeenCalledTimes(2);
  expect(
    [...element.querySelectorAll<HTMLButtonElement>("button[aria-busy]")].every(
      (button) => button.disabled,
    ),
  ).toBe(true);
  await act(async () => {
    await actions.resolve(issue);
    await actions.resolve(other);
  });
  expect(h.apply).toHaveBeenCalledTimes(2);
  h.status.mockImplementation(async (id) => (id === "dep_update" ? ready : running));
  h.feed.mockResolvedValue([{ ...other, details: { inProgressDeploymentId: "dep_other" } }]);
  await tick();
  expect(actions.busyIds).toEqual(new Set([other.id]));
  expect(h.toast).toHaveBeenCalledExactlyOnceWith("success", "Done", "Monitoring");
  h.status.mockResolvedValue(ready);
  h.feed.mockResolvedValue([]);
  await tick();
  expect(actions.busyIds.size).toBe(0);
  expect(h.toast).toHaveBeenCalledTimes(2);
});

it("keeps the clicked row visible through an older or incomplete feed response", async () => {
  await render("page");
  await act(async () => actions.resolve(issue));
  await act(async () => replaceFeed([]));
  expect(button()!.disabled).toBe(true);
  expect(button()!.textContent).toBe("Updating…");
  expect(element.querySelector('a[href="/build/dep_update"]')?.textContent).toBe("MongoDB");
  h.status.mockResolvedValue(ready);
  await tick();
  expect(button()).toBeNull();
});

it.each([
  { status: "failed", deploymentStatus: "failed", errorMessage: "Image pull failed" },
  { status: "cancelled", deploymentStatus: "cancelled", errorMessage: "Deployment cancelled" },
  { status: "ready", deploymentStatus: "partial_failure", warningMessage: "One service failed" },
])(
  "reports $deploymentStatus without a success toast and permits a deliberate retry",
  async (outcome) => {
    await render();
    await act(async () => actions.resolve(issue));
    h.status.mockResolvedValue(outcome);
    h.feed.mockResolvedValue([issue]);
    await tick();
    expect(button()!.disabled).toBe(false);
    expect(button()!.textContent).toBe("Update");
    expect(h.toast).toHaveBeenCalledExactlyOnceWith(
      "error",
      outcome.errorMessage ?? outcome.warningMessage,
      "Monitoring",
    );
    expect(h.apply).toHaveBeenCalledTimes(1);
  },
);

it("does not treat partial-release reconciliation as completion", async () => {
  await render();
  await act(async () => actions.resolve(issue));
  h.status.mockResolvedValue({ status: "ready", deploymentStatus: "reconciling" });
  await tick(15_000);
  expect(button()!.disabled).toBe(true);
  expect(h.toast).not.toHaveBeenCalled();
  h.status.mockResolvedValue(ready);
  await tick();
  expect(h.toast).toHaveBeenCalledTimes(1);
});

it("backs off failed status reads without re-enabling or replaying the mutation", async () => {
  h.status.mockRejectedValue(new TypeError("Network unavailable"));
  await render();
  await act(async () => actions.resolve(issue));
  await tick(9_999);
  expect(h.status).toHaveBeenCalledTimes(1);
  expect(button()!.disabled).toBe(true);
  expect(h.toast).not.toHaveBeenCalled();
  h.status.mockResolvedValue(ready);
  await tick(1);
  expect(h.apply).toHaveBeenCalledTimes(1);
  expect(h.toast).toHaveBeenCalledExactlyOnceWith("success", "Done", "Monitoring");
});

it("pauses status reads while offline and resumes without sending another update", async () => {
  await render();
  await act(async () => actions.resolve(issue));
  const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  await tick(30_000);
  expect(h.status).toHaveBeenCalledTimes(1);
  expect(button()!.disabled).toBe(true);
  online.mockReturnValue(true);
  h.status.mockResolvedValue(ready);
  await act(async () => {
    window.dispatchEvent(new Event("online"));
  });
  expect(h.status).toHaveBeenCalledTimes(2);
  expect(h.apply).toHaveBeenCalledTimes(1);
  expect(button()).toBeNull();
});

it("does not duplicate a completion toast when refreshing the feed fails", async () => {
  await render();
  await act(async () => actions.resolve(issue));
  h.status.mockResolvedValue(ready);
  h.feed.mockRejectedValue(new Error("Feed unavailable"));
  await tick();
  expect(button()!.disabled).toBe(true);
  h.feed.mockResolvedValue([]);
  await tick(10_000);
  expect(h.toast).toHaveBeenCalledExactlyOnceWith("success", "Done", "Monitoring");
  expect(button()).toBeNull();
});

it("stops observing on unmount and ignores a late success", async () => {
  const read = deferred<typeof ready>();
  h.status.mockReturnValue(read.promise);
  await render();
  await act(async () => actions.resolve(issue));
  const signal = h.status.mock.calls[0]![1].signal as AbortSignal;
  await act(async () => root.render(null));
  expect(signal.aborted).toBe(true);
  await act(async () => read.resolve(ready));
  await tick(60_000);
  expect(h.toast).not.toHaveBeenCalled();
  expect(h.feed).not.toHaveBeenCalled();
  expect(h.status).toHaveBeenCalledTimes(1);
});

it("does not observe old workspace deployments after switching organizations", async () => {
  await render("page", [updating]);
  const resolveOld = actions.resolve;
  const signal = h.status.mock.calls[0]![1].signal as AbortSignal;
  await act(async () => setActiveOrganizationId("org_b"));
  expect(signal.aborted).toBe(true);
  await act(async () => resolveOld(issue));
  await tick(60_000);
  expect(h.status).toHaveBeenCalledTimes(1);
  expect(h.apply).not.toHaveBeenCalled();
});

it("ignores an old enqueue response even after switching away and back", async () => {
  const request = deferred<typeof accepted>();
  h.apply.mockReturnValue(request.promise);
  await render();
  await act(async () => {
    void actions.resolve(issue);
  });
  await act(async () => setActiveOrganizationId("org_b"));
  await act(async () => setActiveOrganizationId("org_a"));
  await act(async () => request.resolve(accepted));
  expect(h.status).not.toHaveBeenCalled();
  expect(h.toast).not.toHaveBeenCalled();
  expect(actions.busyIds.size).toBe(0);
});

it("keeps synchronous resolutions immediate and does not start deployment polling", async () => {
  const domain: SystemIssue = {
    ...issue,
    kind: "domain_unverified",
    resolveWith: [{ label: "Verify", method: "POST", path: "/api/domains/domain_1/verify" }],
  };
  h.apply.mockResolvedValue({ success: true });
  await render("page", [domain]);
  await act(async () => actions.resolve(domain));
  expect(h.toast).toHaveBeenCalledExactlyOnceWith("success", "Done", "Monitoring");
  expect(h.status).not.toHaveBeenCalled();
  expect(actions.busyIds.size).toBe(0);
});
