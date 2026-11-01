// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionWorkflowNotifications } from "@repo/core";
import { I18nProvider } from "@/components/i18n-provider";
import { WorkflowChecks } from "./WorkflowChecks";

const h = vi.hoisted(() => ({
  scope: "local",
  user: "owner",
  checks: vi.fn(),
  channels: vi.fn(),
  create: vi.fn(),
  test: vi.fn(),
  change: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@/lib/api/actions", () => ({ actionsApi: { repositoryChecks: h.checks } }));
vi.mock("@/lib/api/notifications", () => ({
  notificationsApi: { listChannels: h.channels, createChannel: h.create, testChannel: h.test },
}));
vi.mock("@/lib/api/system", () => ({
  systemApi: { getEmailSettings: async () => ({ deliverable: true }) },
}));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: h.toast }) }));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: h.user }, session: { activeOrganizationId: "org" } } }),
}));
vi.mock("@/context/CloudResourceContext", () => ({ useCloudResourceKey: () => h.scope }));

const channel = {
  id: "new-channel",
  userId: "owner",
  kind: "email",
  label: "Build alerts",
  config: { address: "owner@example.com" },
  enabled: true,
  verified: false,
  createdAt: "",
  updatedAt: "",
  lastDeliveredAt: null,
};
let root: Root, host: HTMLDivElement;
function Harness({
  repository = "acme/app",
  github = true,
  independent = false,
}: {
  repository?: string | null;
  github?: boolean;
  independent?: boolean;
}) {
  const [value, setValue] = useState<ActionWorkflowNotifications | null>(null);
  return (
    <I18nProvider>
      <WorkflowChecks
        repository={repository}
        github={github}
        independent={independent}
        value={value}
        onChange={(next) => {
          setValue(next);
          h.change(next);
        }}
      />
    </I18nProvider>
  );
}
const render = (props = {}) => act(async () => root.render(<Harness {...props} />));
const button = (name: string) =>
  [
    ...(document.querySelector('[role="dialog"]') ?? document).querySelectorAll<HTMLButtonElement>(
      "button",
    ),
  ].find((item) => item.getAttribute("aria-label") === name || item.textContent?.trim() === name)!;
const click = (name: string) => act(async () => button(name).click());
async function fill(label: string, value: string) {
  const element = [...document.querySelectorAll("label")]
    .find((item) => item.firstElementChild?.textContent === label)
    ?.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function addEmail() {
  await click("Add channel");
  await fill("Name", "Build alerts");
  await fill("Email address", "owner@example.com");
  await click("Add channel");
}
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  h.scope = "local";
  h.user = "owner";
  h.checks.mockResolvedValue({
    repository: "acme/app",
    account: { login: "octocat", avatarUrl: "", kind: "account" },
    status: "connected",
  });
  h.channels.mockResolvedValue({ channels: [] });
  h.create.mockImplementation(async () => {
    h.channels.mockResolvedValue({ channels: [channel] });
    return { channel };
  });
  h.test.mockImplementation(async () => {
    h.channels.mockResolvedValue({ channels: [{ ...channel, verified: true }] });
    return { ok: true, verified: true };
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("workflow Checks setup", () => {
  it("shows the verified repository identity and keeps independent reporting separate", async () => {
    await render({ independent: true });
    expect(host.textContent).toContain("octocat");
    expect(h.checks.mock.calls.map(([input]) => input.controller).sort()).toEqual([
      "github",
      "openship",
    ]);
    expect(host.textContent).not.toContain("Account-wide Actions notifications");
    expect(host.querySelector('a[href*="tab=notifications"]')).toBeNull();
    expect(
      [...host.querySelectorAll("button")].filter(
        (item) => item.textContent?.trim() === "Add channel",
      ),
    ).toHaveLength(1);
  });
  it("shows setup for missing App access and never assumes automatic reporting", async () => {
    h.checks.mockResolvedValue({
      repository: "acme/app",
      account: { login: "octocat", avatarUrl: "", kind: "account" },
      status: "app_required",
    });
    await render({ github: false, independent: true });
    expect(host.textContent).toContain("App needed");
    expect(host.textContent).toContain("Checks write access");
    expect(host.textContent).not.toContain("Automatic");
    expect(button("Connect GitHub")).toBeTruthy();
  });
  it("retries an unavailable connection instead of displaying a false connected state", async () => {
    h.checks.mockRejectedValueOnce(new Error("offline"));
    await render();
    expect(host.textContent).toContain("Unavailable");
    expect(host.textContent).not.toContain("Connected");
    await click("Try again");
    expect(host.textContent).toContain("Connected");
  });
  it("adds a channel inline, then selects it only after the explicit verification succeeds", async () => {
    await render();
    await addEmail();
    expect(h.create).toHaveBeenCalledWith({
      kind: "email",
      label: "Build alerts",
      config: { address: "owner@example.com" },
    });
    expect(h.change).not.toHaveBeenCalled();
    expect(h.test).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Verify channel");
    await click("Send test & use");
    expect(h.test).toHaveBeenCalledWith(channel.id);
    expect(h.change).toHaveBeenLastCalledWith({ channels: [channel.id], events: ["failure"] });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(h.create).toHaveBeenCalledTimes(1);
  });
  it("keeps a failed verification retryable without creating or selecting a second channel", async () => {
    h.test.mockRejectedValueOnce(new Error("Mail server unavailable"));
    await render();
    await addEmail();
    await click("Send test & use");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Mail server unavailable",
    );
    expect(h.change).not.toHaveBeenCalled();
    await click("Send test & use");
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.change).toHaveBeenCalledTimes(1);
  });
  it("does not select a channel when the server has not confirmed verification", async () => {
    h.test.mockResolvedValue({ ok: true, verified: false });
    await render();
    await addEmail();
    await click("Send test & use");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "could not be verified",
    );
    expect(h.change).not.toHaveBeenCalled();
    await click("Later");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(host.textContent).toContain("Needs verification");
  });
  it("uses the refreshed channel state after a previously verified channel is disabled", async () => {
    await render();
    await addEmail();
    await click("Send test & use");
    h.channels.mockResolvedValue({ channels: [{ ...channel, enabled: false, verified: false }] });
    await click("Add channel");
    await click("Close");
    expect(host.textContent).toContain("Disabled");
    expect(button("Verify")).toBeUndefined();
  });
  it("shows a webhook's signing secret before moving to verification", async () => {
    h.create.mockImplementation(async () => {
      const webhook = {
        ...channel,
        kind: "webhook",
        config: { url: "https://hooks.example.com/ci" },
      };
      h.channels.mockResolvedValue({ channels: [webhook] });
      return { channel: webhook, secret: "one-time-test-signing-secret" };
    });
    await render();
    await click("Add channel");
    await click("Channel type");
    await act(async () => {
      [...document.querySelectorAll<HTMLElement>('[role="option"]')]
        .find((item) => item.textContent?.trim() === "Webhook")!
        .click();
    });
    await fill("Name", "Build alerts");
    await fill("Webhook URL", "https://hooks.example.com/ci");
    await click("Add channel");
    expect(document.querySelector<HTMLInputElement>("input[readonly]")?.value).toBe(
      "one-time-test-signing-secret",
    );
    expect(h.test).not.toHaveBeenCalled();
    expect(h.change).not.toHaveBeenCalled();
    await click("Done");
    expect(document.querySelector("input[readonly]")).toBeNull();
    expect(button("Send test & use")).toBeTruthy();
    expect(h.create).toHaveBeenCalledTimes(1);
  });
  it("can finish an existing unverified channel from the same panel", async () => {
    h.channels.mockResolvedValue({ channels: [channel] });
    await render();
    await click("Verify");
    await click("Send test & use");
    expect(h.create).not.toHaveBeenCalled();
    expect(h.change).toHaveBeenLastCalledWith({ channels: [channel.id], events: ["failure"] });
  });
  it("does not carry a private connection or open form into another account", async () => {
    await render();
    await click("Add channel");
    h.scope = "cloud:another";
    h.user = "another";
    h.checks.mockImplementation(() => new Promise(() => {}));
    h.channels.mockImplementation(() => new Promise(() => {}));
    await render();
    expect(host.textContent).not.toContain("octocat");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it("keeps standalone results local without querying GitHub", async () => {
    await render({ repository: null, github: false, independent: true });
    expect(host.textContent).toContain("Job and step results stay in Openship.");
    expect(h.checks).not.toHaveBeenCalled();
  });
});
