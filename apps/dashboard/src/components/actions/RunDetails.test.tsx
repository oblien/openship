// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { RunDetails } from "./RunDetails";

const h = vi.hoisted(() => ({ run: vi.fn(), approve: vi.fn(), runners: vi.fn() }));
vi.mock("@/lib/api/actions", () => ({ actionsApi: h }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "owner" }, session: { activeOrganizationId: "org" } } }),
}));
vi.mock("@/context/CloudResourceContext", () => ({ useCloudResourceKey: () => "local" }));
vi.mock("./WorkflowGraph", () => ({ WorkflowGraph: () => <div>Workflow</div> }));
vi.mock("./ActionLogs", () => ({ ActionLogs: () => null }));
vi.mock("./RunArtifacts", () => ({ RunArtifacts: () => null }));

it("refreshes a rejected approval immediately so an outdated review cannot remain actionable", async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const run = {
    id: "run",
    workflowId: "ci",
    name: "CI",
    number: 1,
    attempt: 1,
    status: "waiting",
    controller: "github",
    owner: "acme",
    repo: "app",
    revision: "a".repeat(40),
    ref: "refs/heads/main",
    actor: "octocat",
    runnerIds: ["linux"],
    canApprove: true,
    jobs: [],
    plan: { name: "CI", jobs: [] },
    admission: { state: "approval_required", reason: "approval_required", key: "b".repeat(64) },
  };
  h.run.mockResolvedValueOnce(run).mockResolvedValue({
    ...run,
    canApprove: false,
    admission: { ...run.admission, state: "blocked", reason: "actor_not_allowed" },
  });
  h.approve.mockRejectedValue(new Error("Run access changed. Review this attempt again."));
  h.runners.mockResolvedValue([{ id: "linux", kind: "server", name: "Build Linux" }]);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <I18nProvider>
          <RunDetails id="run" />
        </I18nProvider>,
      ),
    );
    const approvals = host.querySelector<HTMLButtonElement>("#workflow-view-tab-approvals")!;
    expect(approvals.textContent).toContain("Approval required");
    expect(host.textContent).not.toContain("Approve this attempt");
    await act(async () => approvals.click());
    expect(new URL(window.location.href).searchParams.get("view")).toBe("approvals");
    const approve = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (el) => el.textContent?.trim() === "Approve this attempt",
    )!;
    expect(approve.disabled).toBe(false);
    await act(async () => approve.click());
    expect(h.approve).toHaveBeenCalledExactlyOnceWith("run", "b".repeat(64));
    expect(h.run).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("Run access changed");
    expect(host.textContent).toContain("Runner access blocked");
    expect(host.textContent).not.toContain("Approve this attempt");
    expect(host.querySelector("#workflow-view-tab-approvals")?.textContent).toContain(
      "Runner access blocked",
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
