// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import type { AssistantProviderInfo } from "@repo/contracts";
import { AgentConnections } from "./AgentConnections";

const setup = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/assistant", () => ({ assistantApi: { setupProvider: setup } }));
vi.mock("@/lib/auth-client", () => ({ useSession: () => ({ data: null }) }));

let root: Root, host: HTMLDivElement;
const refresh = vi.fn();
const info: AssistantProviderInfo = {
  id: "codex",
  name: "Codex",
  installedVersion: "",
  available: false,
  authStatus: { configured: false },
  authMethods: [],
  models: [],
  fields: [],
  settings: {},
};
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  setup.mockReset().mockResolvedValue({ accepted: true });
  refresh.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});
async function render(update: Partial<AssistantProviderInfo> = {}, error: string | null = null) {
  await act(async () =>
    root.render(
      <AgentConnections
        agents={[{ ...info, ...update }]}
        selected="codex"
        onSelect={() => {}}
        onRefresh={refresh}
        loading={false}
        error={error}
        hostName="Production Cloud"
      />,
    ),
  );
}
const button = (label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);

it("offers setup on managed hosts and starts only after the explicit action", async () => {
  await render({ setup: { state: "required" } });
  expect(setup).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(10000));
  expect(refresh).not.toHaveBeenCalled();
  await act(async () => button("Set up Codex")!.click());
  expect(setup).toHaveBeenCalledExactlyOnceWith("codex");
  expect(refresh).toHaveBeenCalledTimes(1);
  await render();
  expect(button("Set up Codex")).toBeUndefined();
});

it("polls installation until ready, without letting a second click start it again", async () => {
  await render({ setup: { state: "installing" } });
  expect(button("Setting up…")!.disabled).toBe(true);
  await act(async () => vi.advanceTimersByTime(2000));
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(setup).not.toHaveBeenCalled();
  await render({ available: true });
  await act(async () => vi.advanceTimersByTime(10000));
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("Ready to connect");
});

it("shows an installation request error and permits retry", async () => {
  setup.mockRejectedValueOnce(new Error("Cloud instance is temporarily unavailable"));
  await render({ setup: { state: "failed" } });
  await act(async () => button("Retry setup")!.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "Cloud instance is temporarily unavailable",
  );
  expect(refresh).not.toHaveBeenCalled();
  expect(button("Retry setup")!.disabled).toBe(false);
  await act(async () => button("Retry setup")!.click());
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
