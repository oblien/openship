// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChannelKind, NotificationChannel } from "@/lib/api/notifications";
import { I18nProvider } from "@/components/i18n-provider";
import { NotificationSettings } from "./NotificationSettings";

const m = vi.hoisted(() => ({
  user: "user-a",
  org: "org-a",
  instance: "local",
  role: "admin",
  categories: vi.fn(),
  channels: vi.fn(),
  subscriptions: vi.fn(),
  defaults: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  test: vi.fn(),
  subscribe: vi.fn(),
  setDefault: vi.fn(),
  organization: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ user: { id: m.user } }) }));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { session: { activeOrganizationId: m.org } } }),
  authClient: { organization: { getFullOrganization: m.organization } },
}));
vi.mock("@/context/CloudResourceContext", () => ({ useCloudResourceKey: () => m.instance }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: m.toast }) }));
vi.mock("@/lib/api/system", () => ({
  systemApi: { getEmailSettings: async () => ({ deliverable: true }) },
}));
vi.mock("./NotificationDeliveryHistory", () => ({
  NotificationDeliveryHistory: () => <section aria-label="Delivery history" />,
}));
// The shared form imports its channel API directly; use the same transport
// doubles as the settings editor so interaction tests never send real requests.
vi.mock("@/lib/api/notifications", () => ({
  notificationsApi: {
    createChannel: m.create,
    updateChannel: m.update,
  },
}));
vi.mock("@/lib/api", () => ({
  getApiErrorMessage: (e: Error) => e.message,
  notificationsApi: {
    listCategories: m.categories,
    listChannels: m.channels,
    listSubscriptions: m.subscriptions,
    listDefaults: m.defaults,
    createChannel: m.create,
    updateChannel: m.update,
    deleteChannel: m.remove,
    testChannel: m.test,
    upsertSubscription: m.subscribe,
    upsertDefault: m.setDefault,
  },
}));
let root: Root;
let host: HTMLDivElement;
function channel(kind: ChannelKind = "email", id: string = kind): NotificationChannel {
  return {
    id,
    kind,
    label: `${kind} destination`,
    userId: m.user,
    config: { address: "owner@example.com" },
    enabled: true,
    verified: true,
    lastDeliveredAt: null,
    createdAt: "",
    updatedAt: "",
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
  m.user = "user-a";
  m.org = "org-a";
  m.instance = "local";
  m.role = "admin";
  m.categories.mockResolvedValue({
    categories: [
      {
        id: "deploy.failed",
        group: "deployments",
        label: "Deployment failed",
        description: "A build failed.",
        defaultEnabled: true,
      },
    ],
    groups: [{ id: "deployments", label: "Deployments" }],
  });
  m.channels.mockResolvedValue({ channels: [channel()] });
  m.subscriptions.mockResolvedValue({ subscriptions: [] });
  m.defaults.mockResolvedValue({ defaults: [] });
  m.organization.mockImplementation(async () => ({
    data: { id: m.org, members: [{ userId: m.user, role: m.role }] },
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () =>
    root.render(
      <I18nProvider>
        <NotificationSettings mode="monitoring" />
      </I18nProvider>,
    ),
  );
}
function button(label: string, scope: ParentNode = host) {
  const el = Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.getAttribute("aria-label") === label || b.textContent?.trim() === label,
  );
  expect(el, label).toBeDefined();
  return el!;
}
async function click(label: string, scope?: ParentNode) {
  await act(async () => button(label, scope).click());
}
async function fill(label: string, value: string) {
  const input = Array.from(host.querySelectorAll("label"))
    .find((l) => l.querySelector("span")?.textContent === label)
    ?.querySelector("input");
  expect(input, label).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function choose(label: string) {
  await click("Channel type");
  const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (e) => e.textContent === label,
  );
  expect(option, label).toBeTruthy();
  await act(async () => option!.click());
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

it("renders all seven channel kinds with preferences and history; never sends a test on mount", async () => {
  m.channels.mockResolvedValue({
    channels: (
      ["email", "webhook", "slack", "discord", "msteams", "telegram", "in_app"] as ChannelKind[]
    ).map((k) => channel(k)),
  });
  await render();
  expect(host.querySelectorAll("li")).toHaveLength(7);
  expect(host.textContent).toContain("7 of 7 channels ready");
  expect(host.querySelector('section[aria-label="Alert preferences"]')).not.toBeNull();
  expect(host.querySelector('section[aria-label="Delivery history"]')).toBeNull();
  expect(m.test).not.toHaveBeenCalled();
  expect(
    Array.from(host.querySelectorAll("button")).filter((b) => b.textContent === "Send test"),
  ).toHaveLength(6);
});

it("sends only the clicked channel test and can disable or delete a channel", async () => {
  await render();
  await click("Send test");
  expect(m.test).toHaveBeenCalledExactlyOnceWith("email");
  await click("Enabled: email destination");
  expect(m.update).toHaveBeenCalledExactlyOnceWith("email", { enabled: false });
  await click("More: email destination");
  await click("Delete channel");
  expect(m.remove).toHaveBeenCalledExactlyOnceWith("email");
});

it("opens history inline only when selected and preserves a channel draft on return", async () => {
  await render();
  expect(host.querySelector('section[aria-label="Delivery history"]')).toBeNull();
  await click("Add channel");
  await fill("Name", "On call draft");
  await click("Delivery history");
  expect(host.querySelector('section[aria-label="Delivery history"]')).not.toBeNull();
  expect(host.querySelector('[role="tabpanel"][hidden]')).not.toBeNull();
  await click("Channels & alerts");
  expect(host.querySelector('section[aria-label="Delivery history"]')).toBeNull();
  expect([...host.querySelectorAll<HTMLInputElement>("input")].some((input) => input.value === "On call draft")).toBe(true);
  expect(m.create).not.toHaveBeenCalled();
});

it("filters alert names and descriptions within the selected tab without changing preferences", async () => {
  m.categories.mockResolvedValue({
    categories: [
      {
        id: "deploy.failed", group: "deployments", label: "Deployment failed",
        description: "A build failed.", defaultEnabled: true,
      },
      {
        id: "backup.failed", group: "backups", label: "Backup failed",
        description: "Could not save a snapshot.", defaultEnabled: true,
      },
    ],
    groups: [{ id: "deployments", label: "Deployments" }, { id: "backups", label: "Backups" }],
  });
  await render();
  await click("Search alerts");
  const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;
  const filter = async (query: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, query);
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
  await filter("  SNAPSHOT  ");
  expect(button("Notify me: Backup failed")).toBeDefined();
  expect(host.textContent).not.toContain("Deployment failed");
  await filter("failed");
  await click("Deployments1");
  expect(button("Notify me: Deployment failed")).toBeDefined();
  expect(host.textContent).not.toContain("Backup failed");
  await filter("snapshot");
  expect(host.querySelector('[role="status"]')?.textContent).toBe("No matching alerts.");
  await act(async () => {
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(host.querySelector('input[type="search"]')).toBeNull();
  expect(document.activeElement).toBe(button("Search alerts"));
  expect(button("Notify me: Deployment failed")).toBeDefined();
  await click("Search alerts");
  expect(host.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe("");
  expect(m.subscribe).not.toHaveBeenCalled();
  expect(m.setDefault).not.toHaveBeenCalled();
  expect(m.categories).toHaveBeenCalledTimes(1);
});

it.each([
  ["Email", "email", { "Email address": "new@example.com" }, { address: "new@example.com" }],
  [
    "Webhook",
    "webhook",
    { "Webhook URL": "https://example.com/hook" },
    { url: "https://example.com/hook" },
  ],
  [
    "Slack",
    "slack",
    { "Webhook URL": "https://hooks.slack.com/test" },
    { webhookUrl: "https://hooks.slack.com/test" },
  ],
  [
    "Discord",
    "discord",
    { "Webhook URL": "https://discord.com/api/webhooks/test" },
    { webhookUrl: "https://discord.com/api/webhooks/test" },
  ],
  [
    "Microsoft Teams",
    "msteams",
    { "Webhook URL": "https://example.com/teams" },
    { webhookUrl: "https://example.com/teams" },
  ],
  [
    "Telegram",
    "telegram",
    { "Bot token": "token", "Chat ID": "-123" },
    { botToken: "token", chatId: "-123" },
  ],
] as const)(
  "creates %s using the existing payload without sending a test",
  async (label, kind, fields, config) => {
    await render();
    await click("Add channel");
    await choose(label);
    await fill("Name", " On call ");
    for (const [name, value] of Object.entries(fields)) await fill(name, value);
    await click("Add channel");
    expect(m.create).toHaveBeenCalledExactlyOnceWith({ kind, label: "On call", config });
    expect(m.test).not.toHaveBeenCalled();
  },
);

it("retains explicit opt-out and fans personal subscription changes out to every channel", async () => {
  m.channels.mockResolvedValue({ channels: [channel(), channel("slack")] });
  m.subscriptions.mockResolvedValue({
    subscriptions: [{ category: "deploy.failed", channelId: "email", enabled: false }],
  });
  await render();
  expect(button("Notify me: Deployment failed").getAttribute("aria-checked")).toBe("false");
  await click("Notify me: Deployment failed");
  expect(m.subscribe).toHaveBeenCalledWith({
    category: "deploy.failed",
    channelId: "email",
    enabled: true,
  });
  expect(m.subscribe).toHaveBeenCalledWith({
    category: "deploy.failed",
    channelId: "slack",
    enabled: true,
  });
});

it("preserves category defaults and lets admins change destination kinds", async () => {
  await render();
  expect(button("Notify me: Deployment failed").getAttribute("aria-checked")).toBe("true");
  await click("1 channels");
  await click("Slack");
  expect(m.setDefault).toHaveBeenCalledExactlyOnceWith({
    category: "deploy.failed",
    defaultEnabled: true,
    defaultChannelKinds: ["email", "slack"],
  });
});

it.each(["org", "user", "instance"] as const)(
  "clears private data and drafts immediately when %s changes and fences late responses",
  async (field) => {
    await render();
    await click("Add channel");
    await fill("Name", "Private draft");
    const pending = deferred<{ channels: NotificationChannel[] }>();
    m.channels.mockReturnValueOnce(pending.promise);
    m[field] = "second";
    await render();
    expect(host.textContent).not.toContain("email destination");
    expect(host.querySelector("input")).toBeNull();
    m[field] = "third";
    m.role = "member";
    await render();
    await act(async () => pending.resolve({ channels: [channel("slack", "private-second")] }));
    expect(host.textContent).not.toContain("slack destination");
    expect(button("1 channels").disabled).toBe(true);
  },
);

it("surfaces load failures and supports an explicit retry", async () => {
  m.channels.mockRejectedValueOnce(new Error("Temporarily unavailable"));
  await render();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Temporarily unavailable");
  await click("Retry");
  expect(host.textContent).toContain("email destination");
});

it("does not present failed preference reads as editable empty defaults", async () => {
  m.defaults.mockRejectedValueOnce(new Error("Preferences unavailable"));
  await render();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Preferences unavailable");
  expect(host.querySelector('section[aria-label="Alert preferences"]')).toBeNull();
  expect(m.setDefault).not.toHaveBeenCalled();
  m.defaults.mockResolvedValue({
    defaults: [
      {
        category: "deploy.failed",
        defaultEnabled: false,
        defaultChannelKinds: ["slack"],
      },
    ],
  });
  await click("Retry");
  expect(button("Notify me: Deployment failed").getAttribute("aria-checked")).toBe("false");
  expect(button("Notify me: Deployment failed").disabled).toBe(false);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("keeps the last preferences read-only after refresh failure, until a successful retry", async () => {
  m.defaults.mockResolvedValue({
    defaults: [
      {
        category: "deploy.failed",
        defaultEnabled: false,
        defaultChannelKinds: ["slack"],
      },
    ],
  });
  await render();
  m.defaults.mockRejectedValueOnce(new Error("Preferences unavailable"));
  await click("Send test");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Preferences unavailable");
  expect(button("Notify me: Deployment failed").getAttribute("aria-checked")).toBe("false");
  expect(button("Notify me: Deployment failed").disabled).toBe(true);
  expect(button("1 channels").disabled).toBe(true);
  await click("Retry");
  expect(button("Notify me: Deployment failed").disabled).toBe(false);
  expect(button("1 channels").disabled).toBe(false);
  expect(m.setDefault).not.toHaveBeenCalled();
  expect(m.subscribe).not.toHaveBeenCalled();
});

it("does not refresh or toast into a new scope after a previous channel test finishes", async () => {
  const pending = deferred<{ ok: boolean; verified: boolean }>();
  m.test.mockReturnValueOnce(pending.promise);
  await render();
  await click("Send test");
  m.org = "org-b";
  await render();
  const calls = m.channels.mock.calls.length;
  await act(async () => pending.resolve({ ok: true, verified: true }));
  expect(m.channels).toHaveBeenCalledTimes(calls);
  expect(m.toast).not.toHaveBeenCalled();
});

it("works without props and explains account channels versus organization preferences", async () => {
  await act(async () =>
    root.render(
      <I18nProvider>
        <NotificationSettings />
      </I18nProvider>,
    ),
  );
  expect(host.textContent).toContain(
    "Channels belong to your account and are shared across organizations",
  );
  expect(host.textContent).toContain(
    "Alert preferences and defaults apply to the active organization",
  );
  expect(host.querySelector('section[aria-label="Delivery history"]')).toBeNull();
  await click("Delivery history");
  expect(host.querySelector('section[aria-label="Delivery history"]')).not.toBeNull();
});

it.each(["email", "webhook", "slack", "discord", "msteams", "telegram", "in_app"] as const)(
  "edits %s labels without config or redacted credentials",
  async (kind) => {
    const ch = {
      ...channel(kind),
      config: {
        address: "owner@example.com",
        url: "https://example.com/hook",
        chatId: "-123",
        webhookUrlConfigured: true,
        botTokenConfigured: true,
        hmacSecretConfigured: true,
      },
    };
    m.channels.mockResolvedValue({ channels: [ch] });
    await render();
    await click(`More: ${kind} destination`);
    await click("Edit");
    expect(button("Channel type").disabled).toBe(true);
    await fill("Name", "Renamed");
    await click("Save");
    expect(m.update).toHaveBeenCalledExactlyOnceWith(ch.id, { label: "Renamed" });
    expect(m.test).not.toHaveBeenCalled();
  },
);

it("updates a Telegram destination while retaining the stored token and topic", async () => {
  m.channels.mockResolvedValue({
    channels: [
      {
        ...channel("telegram"),
        config: { botTokenConfigured: true, chatId: "-123", messageThreadId: "42" },
      },
    ],
  });
  await render();
  await click("More: telegram destination");
  await click("Edit");
  await fill("Chat ID", "-456");
  await click("Save");
  expect(m.update).toHaveBeenCalledExactlyOnceWith("telegram", {
    label: "telegram destination",
    config: { chatId: "-456", messageThreadId: "42" },
  });
});

it("changes a Slack credential without dropping its optional channel name or sending configured flags", async () => {
  m.channels.mockResolvedValue({
    channels: [
      { ...channel("slack"), config: { webhookUrlConfigured: true, channelName: "#alerts" } },
    ],
  });
  await render();
  await click("More: slack destination");
  await click("Edit");
  await fill("Webhook URL", "https://hooks.slack.com/services/new");
  await click("Save");
  expect(m.update).toHaveBeenCalledExactlyOnceWith("slack", {
    label: "slack destination",
    config: { webhookUrl: "https://hooks.slack.com/services/new", channelName: "#alerts" },
  });
});

it.each([false, true])(
  "reveals the one-time webhook secret after save (editing=%s) until Done",
  async (editing) => {
    const secret = "one-time-test-secret";
    const result = {
      channel: {
        ...channel("webhook"),
        config: { url: "https://example.com/new", hmacSecretConfigured: true },
        verified: false,
      },
      secret,
    };
    m.channels.mockResolvedValue({
      channels: editing
        ? [
            {
              ...channel("webhook"),
              config: { url: "https://example.com/old", hmacSecretConfigured: true },
            },
          ]
        : [],
    });
    m.create.mockResolvedValue(result);
    m.update.mockResolvedValue(result);
    await render();
    if (editing) await click("More: webhook destination");
    await click(editing ? "Edit" : "Add channel");
    if (!editing) {
      await choose("Webhook");
      await fill("Name", "Receiver");
    }
    await fill("Webhook URL", "https://example.com/new");
    await click(editing ? "Save" : "Add channel");
    expect(host.querySelector<HTMLInputElement>("input[readonly]")?.value).toBe(secret);
    expect(host.querySelector("ul")?.textContent ?? "").not.toContain(secret);
    expect(m.toast.mock.calls.flat().join(" ")).not.toContain(secret);
    expect(m.test).not.toHaveBeenCalled();
    if (editing)
      expect(m.update).toHaveBeenCalledWith("webhook", {
        label: "webhook destination",
        config: { url: "https://example.com/new" },
      });
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await click("Copy");
    expect(copy).toHaveBeenCalledExactlyOnceWith(secret);
    copy.mockRestore();
    await click("Done");
    expect(host.querySelector("input[readonly]")).toBeNull();
  },
);

it("clears a revealed secret on scope change", async () => {
  m.create.mockResolvedValue({ channel: channel("webhook"), secret: "private-secret" });
  await render();
  await click("Add channel");
  await choose("Webhook");
  await fill("Name", "Receiver");
  await fill("Webhook URL", "https://example.com/hook");
  await click("Add channel");
  expect(host.querySelector<HTMLInputElement>("input[readonly]")?.value).toBe("private-secret");
  m.org = "org-b";
  await render();
  expect(host.querySelector("input[readonly]")).toBeNull();
});


it("shows default security alerts for every channel and persists an individual opt-out", async () => {
  m.categories.mockResolvedValue({ categories: [{ id: "security.advisory", group: "security", label: "Security advisories", description: "Security updates", defaultEnabled: true, defaultPerChannel: true, defaultChannelKinds: ["email", "in_app", "webhook"] }], groups: [{ id: "security", label: "Security" }] });
  m.channels.mockResolvedValue({ channels: [channel("email"), channel("webhook")] });
  await render();
  const email = button("Security advisories: email destination");
  const webhook = button("Security advisories: webhook destination");
  expect(email.getAttribute("aria-checked")).toBe("true");
  expect(webhook.getAttribute("aria-checked")).toBe("true");
  await act(async () => webhook.click());
  expect(m.subscribe).toHaveBeenCalledWith({ category: "security.advisory", channelId: "webhook", enabled: false });
  expect(m.subscribe).toHaveBeenCalledTimes(1);
});
