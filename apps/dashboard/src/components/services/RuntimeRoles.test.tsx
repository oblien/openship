// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import type { ProjectRuntimeRoles } from "@repo/contracts";
import { RuntimeRolesCard } from "./RuntimeRoles";

const h = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@/lib/api/project-runtime", () => ({ loadRuntimeRoles: h.load }));
vi.mock("@/components/i18n-provider", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useI18n: () => ({ t: baseDictionary }),
}));
const fixture = (deploymentId = "dep_1", name = "queue"): ProjectRuntimeRoles => ({
  deploymentId,
  error: null,
  roles: [
    {
      name,
      kind: "worker",
      replicas: 2,
      containers: [
        { replica: 1, containerId: "cid_1", status: "running", restartCount: 0 },
        { replica: 2, containerId: "cid_2", status: "restarting", restartCount: 3 },
      ],
    },
  ],
});
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.load.mockReset().mockResolvedValue({ data: fixture() });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("runtime roles in Apps & Services (#1282)", () => {
  it("shows observed replicas/restarts and links each replica to its own release-scoped logs", async () => {
    await act(async () =>
      root.render(<RuntimeRolesCard projectId="proj_1" deploymentId="dep_1" />),
    );
    expect(host.textContent).toContain("queue");
    expect(host.textContent).toContain("3 restarts");
    expect(host.textContent).toContain("2 replicas");
    const links = [...host.querySelectorAll<HTMLAnchorElement>("a")];
    expect(links).toHaveLength(2);
    expect(links.map((link) => new URL(link.href).searchParams.get("replica"))).toEqual(["1", "2"]);
    for (const link of links) {
      const url = new URL(link.href);
      expect(url.searchParams.get("role")).toBe("queue");
      expect(url.searchParams.get("deploymentId")).toBe("dep_1");
    }
  });

  it("shows unknown with retry after a read fails, preserving identity without stale restart counts", async () => {
    await act(async () =>
      root.render(<RuntimeRolesCard projectId="proj_1" deploymentId="dep_1" />),
    );
    h.load.mockRejectedValueOnce(new Error("Connection lost"));
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="Retry"]')!.click(),
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Connection lost");
    expect(host.textContent).toContain("queue");
    expect(host.textContent).not.toContain("3 restarts");
    expect(
      [...host.querySelectorAll('[role="status"]')].every(
        (status) => !status.textContent?.includes("Running"),
      ),
    ).toBe(true);
    h.load.mockResolvedValueOnce({ data: fixture() });
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="Retry"]')!.click(),
    );
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain("3 restarts");
  });

  it("does not reuse a late response after switching projects and releases", async () => {
    let resolveOld!: (value: { data: ProjectRuntimeRoles }) => void;
    h.load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    await act(async () =>
      root.render(<RuntimeRolesCard projectId="proj_old" deploymentId="dep_old" />),
    );
    h.load.mockResolvedValueOnce({ data: fixture("dep_new", "scheduler-new") });
    await act(async () =>
      root.render(<RuntimeRolesCard projectId="proj_new" deploymentId="dep_new" />),
    );
    await act(async () => resolveOld({ data: fixture("dep_old", "old-queue") }));
    expect(host.textContent).toContain("scheduler-new");
    expect(host.textContent).not.toContain("old-queue");
    expect(
      [...host.querySelectorAll<HTMLAnchorElement>("a")].every((link) =>
        link.pathname.includes("proj_new"),
      ),
    ).toBe(true);
  });
});
