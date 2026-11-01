// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionRunView } from "@repo/contracts";
import { I18nProvider } from "@/components/i18n-provider";
import { RunApproval } from "./RunApproval";

const h = vi.hoisted(() => ({ runners: vi.fn(), approve: vi.fn() }));
vi.mock("@/lib/api/actions", () => ({ actionsApi: { runners: h.runners } }));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "owner" }, session: { activeOrganizationId: "org" } } }),
}));
vi.mock("@/context/CloudResourceContext", () => ({ useCloudResourceKey: () => "local" }));

const runner = { id: "linux", kind: "cloud", name: "Temporary Linux" };
const run = {
  id: "run",
  workflowId: "ci",
  revision: "a".repeat(40),
  attempt: 2,
  actor: "octocat",
  triggeringActor: "maintainer",
  runnerIds: [runner.id],
  canApprove: true,
  admission: { state: "approval_required", reason: "approval_required", key: "b".repeat(64) },
} as ActionRunView;
let root: Root, host: HTMLDivElement;
const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (el) => el.textContent?.trim() === label,
  );
const render = (value = run) =>
  act(async () => {
    root.render(
      <I18nProvider>
        <RunApproval run={value} busy={false} onApprove={h.approve} />
      </I18nProvider>,
    );
  });

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  h.runners.mockResolvedValue([runner]);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("run approval review", () => {
  it("shows the commit, attempt, original and retry actors, destinations and Cloud budget before approving", async () => {
    await render();
    expect(host.textContent).toContain("aaaaaaaaaaaa");
    expect(host.textContent).toContain("attempt 2");
    expect(host.textContent).toContain("octocat / maintainer");
    expect(host.textContent).toContain("Temporary Linux");
    expect(host.textContent).toContain("prepaid Actions balance");
    expect(button("Approve this attempt")?.disabled).toBe(false);
    await act(async () => button("Approve this attempt")!.click());
    expect(h.approve).toHaveBeenCalledOnce();
  });

  it("keeps approval closed until destination details are available", async () => {
    let resolve!: (value: unknown) => void;
    h.runners.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await render();
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(button("Approve this attempt")?.disabled).toBe(true);
    await act(async () => resolve([runner]));
    expect(button("Approve this attempt")?.disabled).toBe(false);
  });

  it("explains missing destinations and lets the reviewer retry without approving blindly", async () => {
    h.runners.mockResolvedValueOnce([]);
    await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("destinations");
    expect(button("Approve this attempt")?.disabled).toBe(true);
    await act(async () => button("Try again")!.click());
    expect(h.runners).toHaveBeenCalledTimes(2);
    expect(button("Approve this attempt")?.disabled).toBe(false);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps destination errors retryable and prevents an approval during an error", async () => {
    h.runners.mockRejectedValueOnce(new Error("Runner details unavailable"));
    await render();
    expect(host.textContent).toContain("Runner details unavailable");
    expect(button("Approve this attempt")?.disabled).toBe(true);
    await act(async () => button("Try again")!.click());
    expect(button("Approve this attempt")?.disabled).toBe(false);
  });

  it("explains who can approve instead of showing an unusable button to a reader", async () => {
    await render({ ...run, canApprove: false });
    expect(button("Approve this attempt")).toBeUndefined();
    expect(host.textContent).toContain("administrator");
  });

  it("routes a blocked actor to access settings instead of offering approval", async () => {
    await render({
      ...run,
      admission: { ...run.admission!, state: "blocked", reason: "actor_not_allowed" },
    });
    expect(host.textContent).toContain("Runner access blocked");
    expect(host.textContent).toContain("not allowed");
    expect(button("Approve this attempt")).toBeUndefined();
    expect(host.querySelector("a")?.getAttribute("href")).toBe("/actions/workflows/ci");
  });

  it("keeps a newly blocked admission closed even when the attempt has an older approval", async () => {
    await render({
      ...run,
      approvedAt: "2026-10-11T12:00:00Z",
      admission: { ...run.admission!, state: "blocked", reason: "actor_not_allowed" },
    });
    expect(host.textContent).toContain("Runner access blocked");
    expect(button("Approve this attempt")).toBeUndefined();
  });

  it.each([
    { cancelRequestedAt: "2026-10-11T12:00:00Z" },
    { finishedAt: "2026-10-11T12:00:00Z" },
    { status: "cancelled" as const },
  ])("removes approval after the run closes: %j", async (closed) => {
    await render({ ...run, ...closed });
    expect(host.textContent).toContain("no longer waiting for approval");
    expect(button("Approve this attempt")).toBeUndefined();
    expect(h.runners).not.toHaveBeenCalled();
  });

  it("shows confirmation after approval without retaining an actionable review", async () => {
    await render();
    await render({ ...run, admission: { ...run.admission!, state: "allowed", reason: "allowed" } });
    expect(host.textContent).toContain("Runner access approved");
    expect(button("Approve this attempt")).toBeUndefined();
  });

  it("keeps legacy fork approval behind the same administrator check", async () => {
    await render({
      ...run,
      admission: undefined,
      controller: "openship",
      untrusted: true,
      canApprove: false,
    });
    expect(host.textContent).toContain("disposable Cloud VM");
    expect(host.textContent).toContain("administrator");
    expect(button("Approve isolated run")).toBeUndefined();
    await render({ ...run, admission: undefined, controller: "openship", untrusted: true });
    await act(async () => button("Approve isolated run")!.click());
    expect(h.approve).toHaveBeenCalledOnce();
  });
});
