// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import { RuntimeRoleConfigurationControl } from "./RuntimeRoleConfiguration";
const h = vi.hoisted(() => ({ load: vi.fn(), apply: vi.fn(), push: vi.fn(), scope: "org-one" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock("@/context/CloudResourceContext", () => ({ useCloudResourceKey: () => h.scope }));
vi.mock("@/lib/api/project-runtime", () => ({
  loadRoleConfiguration: h.load,
  applyRoleConfiguration: h.apply,
}));
vi.mock("@/components/i18n-provider", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useI18n: () => ({ t: baseDictionary }),
}));
const fixture = () => ({
  supported: true,
  reason: null,
  deploymentId: "active",
  updatedAt: "2026-10-17T00:00:00.000Z",
  roles: [
    { name: "queue", kind: "worker" as const, command: "exec worker", replicas: 2 },
    { name: "scheduler", kind: "scheduler" as const, command: "exec cron", replicas: 1 },
  ],
});
let host: HTMLDivElement;
let root: Root;
const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((el) =>
    el.textContent?.includes(text),
  )!;
const render = async (dep = "active") =>
  act(async () =>
    root.render(<RuntimeRoleConfigurationControl projectId="project" deploymentId={dep} />),
  );
const click = async (text: string) => act(async () => button(text).click());
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.scope = "org-one";
  h.load.mockReset().mockResolvedValue({ data: fixture() });
  h.apply.mockReset();
  h.push.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
describe("runtime role configuration editor", () => {
  it("submits the reviewed release revision once and keeps singleton scaling disabled", async () => {
    await render();
    await click("Configure roles");
    const counts = [...document.querySelectorAll<HTMLInputElement>('input[type="number"]')];
    expect(counts.map((input) => [input.value, input.disabled])).toEqual([
      ["2", false],
      ["1", true],
    ]);
    let finish!: (value: unknown) => void;
    h.apply.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => {
      const form = document.querySelector("form")!;
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(h.apply).toHaveBeenCalledWith("project", {
      expectedDeploymentId: "active",
      expectedUpdatedAt: fixture().updatedAt,
      roles: fixture().roles,
    });
    expect(button("Cancel").disabled).toBe(true);
    await act(async () => finish({ data: { deploymentId: "configuration" } }));
    expect(h.push).toHaveBeenCalledWith("/build/configuration");
  });
  it("distinguishes failed reads from an empty role configuration and retries", async () => {
    h.load.mockRejectedValueOnce(new Error("Connection lost"));
    await render();
    await click("Configure roles");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Connection lost");
    expect(button("Apply changes")).toBeUndefined();
    await click("Try again");
    expect(document.querySelector('[role="alert"]')).toBeNull();
    await click("Add worker");
    expect(document.querySelectorAll("fieldset")).toHaveLength(3);
  });
  it("discards a private editor and ignores late writes when the account scope changes", async () => {
    await render();
    await click("Configure roles");
    let finish!: (value: unknown) => void;
    h.apply.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () =>
      document
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    h.scope = "org-two";
    await render();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => finish({ data: { deploymentId: "private" } }));
    expect(h.push).not.toHaveBeenCalled();
  });
});
