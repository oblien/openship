// @vitest-environment happy-dom
import { act, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import type { AssistantProviderInfo } from "@repo/contracts";
import { AgentConnections, type AssistantConnectionSelection } from "./AgentConnections";

const setup = vi.hoisted(() => vi.fn());
const auth = vi.hoisted(() => ({ begin: vi.fn(), step: vi.fn() }));
const customApi = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/assistant", () => ({
  assistantApi: {
    setupProvider: setup,
    authBegin: auth.begin,
    authStep: auth.step,
    customApi,
  },
}));
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
  auth.begin.mockReset();
  auth.step.mockReset();
  customApi.mockReset();
  refresh.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

async function renderInline(overrides: Partial<ComponentProps<typeof AgentConnections>> = {}) {
  function Harness() {
    const [selected, setSelected] = useState<AssistantConnectionSelection>("codex");
    return (
      <AgentConnections
        inline
        agents={[{ ...info, available: true, customApiAvailable: true }]}
        selected={selected}
        onSelect={setSelected}
        onRefresh={refresh}
        loading={false}
        error={null}
        {...overrides}
      />
    );
  }
  await act(async () => root.render(<Harness />));
}

async function fill(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("offers every advertised method inline without beginning sign-in on selection", async () => {
  const methods = [
    { id: "loginDevice", label: "Continue with ChatGPT using a device code", interactive: true },
    { id: "apiKey", label: "API key" },
    { id: "accessToken", label: "Access token" },
    { id: "azureFoundry", label: "Microsoft Foundry" },
  ];
  await renderInline({ agents: [{ ...info, available: true, authMethods: methods }] });
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  for (const method of methods) expect(button(method.label)).toBeTruthy();
  await act(async () => button("Microsoft Foundry")!.click());
  expect(button("Microsoft Foundry")!.getAttribute("aria-pressed")).toBe("true");
  expect(auth.begin).not.toHaveBeenCalled();
  auth.begin.mockResolvedValue({ method: "azureFoundry", status: "needs_input", fields: [] });
  await act(async () => button("Continue")!.click());
  expect(auth.begin).toHaveBeenCalledExactlyOnceWith("codex", "azureFoundry");
});

it("includes Custom API in keyboard navigation and preserves its draft across provider switches", async () => {
  await renderInline();
  const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  await act(async () =>
    tabs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })),
  );
  expect(tabs.at(-1)!.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(tabs.at(-1));
  const name = host.querySelector<HTMLInputElement>('input[placeholder="e.g. Our AI gateway"]')!;
  await fill(name, "Team gateway");
  await act(async () => tabs[0].click());
  expect(name.closest<HTMLElement>('[role="tabpanel"]')!.hidden).toBe(true);
  await act(async () => tabs.at(-1)!.click());
  expect(name.value).toBe("Team gateway");
  expect(customApi).not.toHaveBeenCalled();
});

it("keeps native input when changing provider tabs or reselecting the active sign-in method", async () => {
  auth.begin.mockResolvedValue({
    method: "apiKey",
    status: "needs_input",
    fields: [{ key: "apiKey", label: "API key", type: "secret", required: true }],
  });
  await renderInline({
    agents: [{ ...info, available: true, authMethods: [{ id: "apiKey", label: "API key" }] }],
  });
  await act(async () => button("Continue")!.click());
  const input = host.querySelector<HTMLInputElement>(
    '[role="tabpanel"]:not([hidden]) input[type="password"]',
  )!;
  await fill(input, "synthetic-test-key");
  const tabs = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  await act(async () => tabs[1].click());
  await act(async () => tabs[0].click());
  await act(async () => button("API key")!.click());
  expect(input.value).toBe("synthetic-test-key");
  expect(input.isConnected).toBe(true);
  auth.step.mockResolvedValue({ method: "apiKey", status: "complete" });
  await act(async () => button("Connect")!.click());
  expect(auth.step).toHaveBeenCalledExactlyOnceWith("codex", { apiKey: "synthetic-test-key" });
});

it("selects an existing host connection but requires an explicit action to reuse it", async () => {
  await renderInline({
    agents: [
      {
        ...info,
        available: true,
        authMethods: [
          {
            id: "loginDevice",
            label: "Continue with ChatGPT using a device code",
            interactive: true,
          },
          { id: "apiKey", label: "API key", existing: { name: "Team key" } },
        ],
      },
    ],
  });
  expect(button("API key")!.getAttribute("aria-pressed")).toBe("true");
  expect(auth.begin).not.toHaveBeenCalled();
  auth.begin.mockResolvedValue({ method: "apiKey", status: "complete" });
  await act(async () => button("Use existing connection")!.click());
  expect(auth.begin).toHaveBeenCalledExactlyOnceWith("codex", "apiKey");
});

it("uses only a ready saved custom model and preserves its full provider/model identifier", async () => {
  const onUse = vi.fn();
  await renderInline({
    onUse,
    agents: [
      {
        ...info,
        available: true,
        customApiAvailable: true,
        authStatus: { configured: true },
        customProviders: [
          {
            id: "openship-team",
            name: "Team gateway",
            baseUrl: "https://example.com/v1",
            models: ["team/coder"],
            hasKey: true,
          },
          {
            id: "openship-empty",
            name: "Missing key",
            baseUrl: "https://example.com/v1",
            models: ["unready"],
            hasKey: false,
          },
        ],
      },
    ],
  });
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Use unready"]')!.disabled).toBe(true);
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Use team/coder"]')!.click(),
  );
  expect(onUse).toHaveBeenCalledExactlyOnceWith("codex", "openship-team/team/coder");
  expect(auth.begin).not.toHaveBeenCalled();
});

it("saves a custom connection once and selects the model returned by the API", async () => {
  const onUse = vi.fn();
  customApi.mockResolvedValue({ model: "openship-team/team-coder" });
  await renderInline({ onUse });
  await act(async () => host.querySelector<HTMLButtonElement>('[role="tab"]:last-child')!.click());
  const inputs = [
    ...host.querySelectorAll<HTMLInputElement>('[role="tabpanel"]:not([hidden]) input'),
  ];
  const values = ["Team gateway", "https://example.com/v1", "team-coder", "synthetic-key"];
  for (const [index, input] of inputs.entries()) await fill(input, values[index]);
  await act(async () => button("Save connection")!.click());
  expect(customApi).toHaveBeenCalledExactlyOnceWith({
    name: values[0],
    baseUrl: values[1],
    model: values[2],
    apiKey: values[3],
  });
  expect(refresh).toHaveBeenCalledOnce();
  expect(onUse).toHaveBeenCalledExactlyOnceWith("codex", "openship-team/team-coder");
  expect(inputs.every((input) => input.value === "")).toBe(true);
});

async function renderCustom(agent?: AssistantProviderInfo) {
  await act(async () =>
    root.render(
      <AgentConnections
        agents={agent ? [agent] : []}
        selected="custom"
        onSelect={() => {}}
        onRefresh={refresh}
        loading={!agent}
        error={null}
      />,
    ),
  );
}
const customPanel = () => host.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')!;
const customButton = (label: string) =>
  [...customPanel().querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!;

it("uses the existing setup job for a custom API and preserves its draft through installation", async () => {
  await renderCustom({ ...info, setup: { state: "required" } });
  expect(customPanel().textContent).not.toContain("Update");
  expect(setup).not.toHaveBeenCalled();
  const inputs = [...customPanel().querySelectorAll("input")];
  const values = ["Team gateway", "https://example.com/v1", "team-coder", "synthetic-key"];
  for (const [index, input] of inputs.entries()) await fill(input, values[index]);
  expect(customButton("Save connection").disabled).toBe(true);
  await act(async () => {
    customPanel()
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(customApi).not.toHaveBeenCalled();
  await act(async () => customButton("Set up Codex").click());
  expect(setup).toHaveBeenCalledExactlyOnceWith("codex");
  expect(refresh).toHaveBeenCalledOnce();
  expect(customApi).not.toHaveBeenCalled();

  await renderCustom({ ...info, setup: { state: "installing" } });
  expect(customButton("Setting up…").disabled).toBe(true);
  await act(async () => vi.advanceTimersByTime(2000));
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(setup).toHaveBeenCalledOnce();

  await renderCustom({ ...info, available: true, customApiAvailable: true });
  expect(inputs.map((input) => input.value)).toEqual(values);
  expect(customButton("Save connection").disabled).toBe(false);
  customApi.mockResolvedValue({ model: "openship-team/team-coder" });
  await act(async () => customButton("Save connection").click());
  expect(customApi).toHaveBeenCalledExactlyOnceWith({
    name: values[0],
    baseUrl: values[1],
    model: values[2],
    apiKey: values[3],
  });
  expect(auth.begin).not.toHaveBeenCalled();
  expect(inputs.every((input) => input.value === "")).toBe(true);
});

it("does not label loading or an uninstalled local agent as an outdated runtime", async () => {
  await renderCustom();
  expect(customPanel().textContent).toContain("Checking your connection");
  expect(customPanel().textContent).not.toContain("Update");
  await renderCustom(info);
  expect(customPanel().textContent).toContain("Install Codex on your assistant host");
  expect(customPanel().textContent).not.toContain("Update");
  expect(customButton("Save connection").disabled).toBe(true);
  expect(setup).not.toHaveBeenCalled();
});

it("reserves the update hint for an available agent that lacks custom API support", async () => {
  await renderCustom({ ...info, available: true, customApiAvailable: false });
  expect(customPanel().textContent).toContain("Update OpenShip and reconnect");
  expect(customButton("Save connection").disabled).toBe(true);
  expect(setup).not.toHaveBeenCalled();
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
  await render({
    available: true,
    authMethods: [{ id: "login", label: "Continue with ChatGPT", interactive: true }],
  });
  await act(async () => vi.advanceTimersByTime(10000));
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(button("Continue")).toBeTruthy();
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

it("shows a device code and completes sign-in through the scoped polling flow", async () => {
  auth.begin.mockResolvedValue({
    method: "loginDevice",
    status: "pending",
    flowId: "device-attempt",
    url: "https://auth.openai.com/codex/device",
    code: "ABCD-1234",
  });
  auth.step.mockResolvedValue({ method: "loginDevice", status: "complete" });
  await render({
    available: true,
    authMethods: [
      { id: "loginDevice", label: "Continue with ChatGPT using a device code", interactive: true },
    ],
  });
  expect(host.textContent).toContain("Cloud and remote servers use a one-time code.");
  expect(auth.begin).not.toHaveBeenCalled();
  await act(async () => button("Continue")!.click());
  expect(auth.begin).toHaveBeenCalledExactlyOnceWith("codex", "loginDevice");
  expect(host.textContent).toContain("ABCD-1234");
  expect(
    host.querySelector<HTMLAnchorElement>('a[href="https://auth.openai.com/codex/device"]'),
  ).toBeTruthy();
  await act(async () => vi.advanceTimersByTime(1500));
  expect(auth.step).toHaveBeenCalledExactlyOnceWith("codex", { _flowId: "device-attempt" });
  expect(refresh).toHaveBeenCalledOnce();
  expect(host.textContent).not.toContain("Waiting for sign-in…");
});

it("defaults to browser sign-in on Desktop and explains it before starting", async () => {
  await render({ available: true });
  await render({
    available: true,
    authMethods: [{ id: "login", label: "Continue with ChatGPT", interactive: true }],
  });
  expect(host.textContent).toContain("On this desktop, sign in with ChatGPT in your browser");
  expect(host.textContent).not.toContain("Cloud and remote servers use a one-time code.");
  expect(auth.begin).not.toHaveBeenCalled();
  auth.begin.mockResolvedValue({
    method: "login",
    status: "pending",
    flowId: "browser-attempt",
    url: "https://auth.openai.com/authorize",
  });
  await act(async () => button("Continue")!.click());
  expect(auth.begin).toHaveBeenCalledExactlyOnceWith("codex", "login");
});
