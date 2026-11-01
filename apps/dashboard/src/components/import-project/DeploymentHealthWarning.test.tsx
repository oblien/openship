// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVICE_STARTING_HEALTH_WARNING } from "@repo/core";
import { baseDictionary } from "@/i18n";
import { DeploymentHealthWarning } from "./DeploymentHealthWarning";

const h = vi.hoisted(() => ({ info: vi.fn(), containers: vi.fn(), org: "org-a" }));
vi.mock("@/lib/api", () => ({
  projectsApi: { getInfo: h.info },
  servicesApi: { containers: h.containers },
  getApiErrorMessage: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));
vi.mock("@/lib/api/client", () => ({ getActiveOrganizationId: () => h.org }));
vi.mock("@/components/i18n-provider", () => ({ useI18n: () => ({ t: baseDictionary }) }));
const copy = baseDictionary.importProject.deploymentHealth;
const warning = `odoo: ${SERVICE_STARTING_HEALTH_WARNING}`;
const row = (
  status = "starting",
  health: "healthy" | "starting" | "unhealthy" | null = "starting",
) => ({
  serviceId: "svc",
  serviceName: "odoo",
  containerId: "container",
  status,
  health,
  ip: null,
  hostPort: null,
  imageRef: null,
});
let host: HTMLDivElement;
let root: Root;
let onResolved: ReturnType<typeof vi.fn<(resolved: boolean) => void>>;

beforeEach(() => {
  vi.clearAllMocks();
  h.org = "org-a";
  h.info.mockResolvedValue({ data: { project: { activeDeploymentId: "dep" } } });
  h.containers.mockResolvedValue({ containers: [row()] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  onResolved = vi.fn<(resolved: boolean) => void>();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function render(message = warning) {
  await act(async () =>
    root.render(
      <DeploymentHealthWarning
        projectId="project"
        deploymentId="dep"
        warningMessage={message}
        onResolved={onResolved}
      />,
    ),
  );
}
async function click() {
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
}

describe("deployment startup-health recovery", () => {
  it("prevents duplicate rechecks, resolves verified startup health and retains the deployment history", async () => {
    await render();
    expect(host.textContent).toContain(copy.startupHint);
    expect(host.querySelector("a")?.getAttribute("href")).toBe("/projects/project/logs");
    let complete!: (value: unknown) => void;
    h.containers.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    await click();
    expect(host.querySelector("button")?.disabled).toBe(true);
    await click();
    expect(h.containers).toHaveBeenCalledTimes(2);
    await act(async () => complete({ containers: [row("running", "healthy")] }));
    expect(host.querySelector("[role=status]")?.textContent).toBe(copy.healthy);
    expect(onResolved).toHaveBeenLastCalledWith(true);
    expect(host.querySelector("details")?.textContent).toContain(warning);
    expect(host.textContent).not.toContain(copy.startupHint);
  });
  it("follows a starting healthcheck briefly and stops after recovery", async () => {
    vi.useFakeTimers();
    await render();
    h.containers.mockResolvedValue({ containers: [row("running", "healthy")] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(onResolved).toHaveBeenLastCalledWith(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(h.containers).toHaveBeenCalledTimes(2);
  });
  it("keeps warnings and exposes retry after connection loss, without more automatic requests", async () => {
    vi.useFakeTimers();
    h.containers.mockRejectedValueOnce(new Error("Connection lost"));
    await render();
    expect(host.querySelector("[role=alert]")?.textContent).toBe("Connection lost");
    expect(host.textContent).toContain(warning);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(h.containers).toHaveBeenCalledTimes(1);
    h.containers.mockResolvedValue({ containers: [row("running", "healthy")] });
    await click();
    expect(host.querySelector("[role=alert]")).toBeNull();
    expect(onResolved).toHaveBeenLastCalledWith(true);
  });
  it.each([
    row("running", null),
    row("failed", "unhealthy"),
    row("unknown", null),
    { ...row("running", "healthy"), containerId: null },
  ])("does not resolve without a reported healthy running container: %j", async (container) => {
    h.containers.mockResolvedValue({ containers: [container] });
    await render();
    expect(onResolved).toHaveBeenLastCalledWith(false);
    expect(host.textContent).toContain(warning);
    expect(host.querySelector("details")).toBeNull();
  });
  it("preserves unrelated warnings when the startup healthcheck recovers", async () => {
    h.containers.mockResolvedValue({ containers: [row("running", "healthy")] });
    const message = `${warning}; DNS verification is still pending`;
    await render(message);
    expect(onResolved).toHaveBeenLastCalledWith(false);
    expect(host.textContent).toContain(message);
  });
  it("never checks an old deployment against the current stack", async () => {
    h.info.mockResolvedValueOnce({ data: { project: { activeDeploymentId: "newer" } } });
    await render();
    expect(h.containers).not.toHaveBeenCalled();
    expect(host.querySelector("[role=alert]")?.textContent).toBe(copy.historical);
  });
  it("rejects a deployment replacement during the health read", async () => {
    h.info
      .mockResolvedValueOnce({ data: { project: { activeDeploymentId: "dep" } } })
      .mockResolvedValueOnce({ data: { project: { activeDeploymentId: "newer" } } });
    h.containers.mockResolvedValue({ containers: [row("running", "healthy")] });
    await render();
    expect(onResolved).toHaveBeenLastCalledWith(false);
    expect(host.querySelector("[role=alert]")?.textContent).toBe(copy.historical);
  });
  it("discards an in-flight read when the organization changes", async () => {
    let complete!: (value: unknown) => void;
    h.containers.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    await render();
    h.org = "org-b";
    await act(async () => complete({ containers: [row("running", "healthy")] }));
    expect(onResolved).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain(copy.healthy);
  });
});
