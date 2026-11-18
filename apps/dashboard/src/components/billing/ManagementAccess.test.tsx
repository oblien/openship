// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PRICING } from "@repo/core";
import type { ManagementState } from "@repo/contracts";
import { ManagementAccess } from "./ManagementAccess";
import { PlatformProvider } from "@/context/PlatformContext";
import { ServerForm } from "@/components/servers/server-form";
import { setActiveOrganizationId } from "@/lib/api/client";
import { baseDictionary } from "@/i18n";

const h = vi.hoisted(() => ({
  user: "owner",
  org: "org-one",
  cloud: "cloud-one",
  get: vi.fn(),
  purchase: vi.fn(),
  resumeCheckout: vi.fn(),
  cancelCheckout: vi.fn(),
  saveServer: vi.fn(),
  testServer: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: h.user }, session: { activeOrganizationId: h.org } } }),
}));
vi.mock("@/context/CloudResourceContext", () => ({ useCloudResourceKey: () => h.cloud }));
vi.mock("@/lib/api/management", () => ({ managementApi: h }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: h.toast }) }));
vi.mock("@/lib/api", async () => ({
  getApiErrorMessage: (await import("@/lib/api/client")).getApiErrorMessage,
  systemApi: {
    createServerEntry: h.saveServer,
    testConnection: h.testServer,
    hasNativeFilePicker: () => false,
  },
}));

let root: Root, host: HTMLDivElement;
let state: ManagementState;
const render = (serverId?: string) =>
  act(async () =>
    root.render(
      <ManagementAccess serverId={serverId}>
        <form aria-label="Server connection">
          <input aria-label="SSH host" />
        </form>
      </ManagementAccess>,
    ),
  );
const form = () => host.querySelector('form[aria-label="Server connection"]');
function button(text: string) {
  const result = [...host.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === text,
  );
  expect(result, text).toBeDefined();
  return result!;
}
const click = (text: string) => act(async () => button(text).click());

beforeEach(() => {
  vi.resetAllMocks();
  setActiveOrganizationId(null);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.user = "owner";
  h.org = "org-one";
  h.cloud = "cloud-one";
  state = {
    pricing: PRICING.management,
    purchasesAvailable: true,
    cloudIncluded: false,
    active: false,
    serverLimit: 0,
    connectedServers: 0,
    pendingCheckout: false,
    subscription: null,
    change: null,
  };
  h.get.mockImplementation(async () => structuredClone(state));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  setActiveOrganizationId(null);
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("offers the shared checkout inline without mounting the connection form or fetching twice", async () => {
  await render();
  expect(h.get).toHaveBeenCalledTimes(1);
  expect(form()).toBeNull();
  expect(host.querySelector('a[href="/billing/manage"]')).toBeNull();
  expect(host.textContent).toContain("OpenShip Manage");
  expect(host.textContent).not.toContain("Need dedicated hardware?");
  const redirect = vi.spyOn(window.location, "assign").mockImplementation(() => {});
  h.purchase.mockResolvedValue({ url: "https://checkout.stripe.com/inline" });
  await click("Continue to checkout");
  expect(h.purchase).toHaveBeenCalledWith({
    servers: PRICING.management.includedServers,
    plan: "basic",
    idempotencyKey: expect.any(String),
  });
  expect(redirect).toHaveBeenCalledWith("https://checkout.stripe.com/inline");
  expect(form()).toBeNull();
});

it("selects Priority through the shared plan and submits its identity without granting access", async () => {
  await render();
  expect(host.querySelector<HTMLInputElement>('input[type="radio"][value="basic"]')?.checked).toBe(true);
  expect(host.textContent).toContain("Email support");
  expect(host.textContent).toContain("Priority support");
  expect(host.textContent).toContain("$20");
  await act(async () => host.querySelector<HTMLInputElement>('input[type="radio"][value="priority"]')!.click());
  h.purchase.mockResolvedValue({ url: null, kind: "quote", monthlyCents: 2000, amountDueNow: 1500, quoteId: "priority-quote" });
  await click("Continue to checkout");
  expect(h.purchase).toHaveBeenCalledWith({ servers: 2, plan: "priority", idempotencyKey: expect.any(String) });
  expect(form()).toBeNull();
});

it.each([
  { active: true, connected: 1, limit: 2, serverId: undefined, allowed: true },
  { active: true, connected: 2, limit: 2, serverId: undefined, allowed: false },
  { active: true, connected: 2, limit: 2, serverId: "existing", allowed: true },
  { active: false, connected: 0, limit: 2, serverId: "existing", allowed: false },
])(
  "keeps allowance enforcement for $active / $connected of $limit / $serverId",
  async ({ active, connected, limit, serverId, allowed }) => {
    Object.assign(state, { active, connectedServers: connected, serverLimit: limit });
    await render(serverId);
    expect(!!form()).toBe(allowed);
    if (active && !allowed)
      expect(host.textContent).toContain("All 2 connected-server slots are in use");
    expect(h.get).toHaveBeenCalledTimes(1);
  },
);

it("resumes or cancels a saved checkout before offering another purchase", async () => {
  state.pendingCheckout = true;
  const redirect = vi.spyOn(window.location, "assign").mockImplementation(() => {});
  h.resumeCheckout.mockResolvedValue({ url: "https://checkout.stripe.com/saved" });
  h.cancelCheckout.mockImplementation(async () => {
    state.pendingCheckout = false;
    return { canceled: true };
  });
  await render();
  expect(host.textContent).not.toContain("Continue to checkout");
  await click("Resume checkout");
  expect(redirect).toHaveBeenCalledWith("https://checkout.stripe.com/saved");
  await click("Cancel checkout");
  expect(h.cancelCheckout).toHaveBeenCalledTimes(1);
  expect(button("Continue to checkout").disabled).toBe(false);
  expect(form()).toBeNull();
});

it("waits for confirmed payment, then reveals the form and stops idle polling", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  state.pendingCheckout = true;
  await render();
  expect(form()).toBeNull();
  Object.assign(state, { pendingCheckout: false, active: true, serverLimit: 2 });
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(form()).not.toBeNull();
  expect(h.get).toHaveBeenCalledTimes(2);
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(h.get).toHaveBeenCalledTimes(2);
});

it("keeps the SSH form and typed credentials through a slow plan check and retry", async () => {
  let reject!: (error: Error) => void;
  h.get.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  await render();
  const { checkingAccess, checkingAccessHint } = baseDictionary.billing.managementPlans;
  expect(host.querySelector('[role="status"]')?.textContent).toContain(checkingAccess);
  expect(host.querySelector('[role="status"]')?.textContent).toContain(checkingAccessHint);
  const input = form()?.querySelector("input");
  expect(input).toBeDefined();
  input!.value = "vps.example.test";
  await act(async () => reject(new Error("Unable to check allowance")));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Unable to check allowance");
  expect(form()?.querySelector("input")).toBe(input);
  let finish!: (value: ManagementState) => void;
  h.get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await click("Try again");
  expect(host.querySelector('[role="status"]')?.textContent).toContain(checkingAccess);
  await act(async () => finish({ ...state, active: true, serverLimit: 2 }));
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(form()?.querySelector("input")).toBe(input);
  expect(input!.value).toBe("vps.example.test");
});

it.each([
  { action: "save", switchTo: "workspace" },
  { action: "test", switchTo: "workspace" },
  { action: "save", switchTo: "account" },
  { action: "test", switchTo: "account" },
])("discards a late SSH $action response after switching $switchTo", async ({ action, switchTo }) => {
  const onSaved = vi.fn();
  const operation = action === "save" ? h.saveServer : h.testServer;
  let finish!: (value: unknown) => void;
  operation.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  Object.assign(state, { active: true, serverLimit: 2 });
  const renderForm = () => act(async () => root.render(
    <PlatformProvider selfHosted={false}><ServerForm onSaved={onSaved} /></PlatformProvider>,
  ));
  await renderForm();
  const input = (placeholder: string) =>
    host.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!;
  const fill = async (field: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const hostField = "123.45.67.89";
  const passwordField = "Enter server password";
  await fill(input(hostField), "host.example.test");
  await fill(input(passwordField), "temporary-test-value");
  await click(action === "save" ? baseDictionary.servers.form.saveAndContinue : baseDictionary.servers.form.testConnection);
  expect(operation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sshHost: "host.example.test" }));
  if (switchTo === "workspace") await act(async () => setActiveOrganizationId("org-two"));
  else {
    h.user = "second-account";
    await renderForm();
  }
  expect(input(hostField).value).toBe("");
  expect(input(passwordField).value).toBe("");
  await act(async () => finish({ id: "previous-org-server", ok: true, message: "Connection succeeded" }));
  expect(onSaved).not.toHaveBeenCalled();
  expect(h.toast).not.toHaveBeenCalled();
});

it.each(["user", "org", "cloud"] as const)(
  "discards checkout results after switching %s",
  async (scope) => {
    let finish!: (value: unknown) => void;
    h.purchase.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const redirect = vi.spyOn(window.location, "assign").mockImplementation(() => {});
    await render();
    await click("Continue to checkout");
    h[scope] = "another";
    await render();
    await act(async () => finish({ url: "https://checkout.stripe.com/previous" }));
    expect(redirect).not.toHaveBeenCalled();
    expect(button("Continue to checkout").disabled).toBe(false);
    expect(form()).toBeNull();
  },
);

it("discards a previous workspace's late allowance response", async () => {
  let finish!: (value: ManagementState) => void;
  h.get.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  h.org = "org-two";
  await render();
  await act(async () => finish({ ...state, active: true, serverLimit: 10 }));
  expect(form()).toBeNull();
  expect(button("Continue to checkout").disabled).toBe(false);
});
