// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import settings from "@/i18n/locales/en/settings.json";
import { NotificationDeliveryHistory } from "./NotificationDeliveryHistory";
import type { NotificationDelivery } from "@/lib/api/notifications";

const mocks = vi.hoisted(() => ({
  scope: { user: "alice", org: "one", cloud: "local" },
  listDeliveries: vi.fn(),
  listCategories: vi.fn(),
  markSeen: vi.fn(),
  testChannel: vi.fn(),
}));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({
    data: mocks.scope.user
      ? {
          user: { id: mocks.scope.user },
          session: { activeOrganizationId: mocks.scope.org },
        }
      : null,
  }),
}));
vi.mock("@/context/CloudResourceContext", () => ({ useCloudResourceKey: () => mocks.scope.cloud }));
vi.mock("@/lib/api/client", () => ({ getApiBaseUrl: () => "http://localhost/api" }));
vi.mock("@/lib/api/notifications", () => ({ notificationsApi: mocks }));
vi.mock("@/components/i18n-provider", () => ({
  useI18n: () => ({ t: { settings }, locale: "en" }),
  interpolate: (value: string, args: Record<string, string>) =>
    value.replace(/\{(\w+)\}/g, (_, key) => args[key]),
}));
vi.mock("@/components/AppLogo", () => ({
  AppLogo: ({ slug }: { slug: string }) => <span data-logo={slug} />,
}));
vi.mock("@repo/ui/icons", () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
}));

let root: Root;
let host: HTMLDivElement;
function delivery(overrides: Partial<NotificationDelivery> = {}): NotificationDelivery {
  return {
    id: "delivery-1",
    userId: "alice",
    organizationId: "one",
    category: "deployment.failed",
    channelId: "channel-1",
    channelKind: "slack",
    status: "sent",
    attempts: 1,
    payload: {},
    lastError: null,
    createdAt: "2026-10-11T10:00:00Z",
    sentAt: null,
    seenAt: null,
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { resolve, reject, promise };
}
async function render() {
  await act(async () => root.render(<NotificationDeliveryHistory />));
}
async function refresh() {
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
}
function button(label: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")]
    .find((element) => element.textContent?.trim() === label)!;
}
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  Object.assign(mocks.scope, { user: "alice", org: "one", cloud: "local" });
  mocks.listDeliveries.mockReset().mockResolvedValue({ deliveries: [] });
  mocks.listCategories.mockReset().mockResolvedValue({
    categories: [{ id: "deployment.failed", label: "Deployment failed" }],
    groups: [],
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("NotificationDeliveryHistory", () => {
  it("pages through older deliveries and refreshes back to the newest page without mutations", async () => {
    const rows = Array.from({ length: 53 }, (_, index) => delivery({ id: `delivery-${index}` }));
    mocks.listDeliveries.mockImplementation(async ({ before, limit }) => {
      const start = before ? rows.findIndex((row) => row.id === before) + 1 : 0;
      return { deliveries: rows.slice(start, start + limit) };
    });
    await render();
    expect(host.querySelectorAll("li")).toHaveLength(25);
    expect(button("Previous").disabled).toBe(true);
    await act(async () => button("Next").click());
    expect(mocks.listDeliveries).toHaveBeenLastCalledWith({ limit: 26, before: "delivery-24" });
    expect(host.textContent).toContain("Page 2");
    await act(async () => button("Next").click());
    expect(mocks.listDeliveries).toHaveBeenLastCalledWith({ limit: 26, before: "delivery-49" });
    expect(host.querySelectorAll("li")).toHaveLength(3);
    expect(button("Next").disabled).toBe(true);
    await act(async () => button("Previous").click());
    expect(mocks.listDeliveries).toHaveBeenLastCalledWith({ limit: 26, before: "delivery-24" });
    await refresh();
    expect(mocks.listDeliveries).toHaveBeenLastCalledWith({ limit: 26, before: undefined });
    expect(host.textContent).toContain("Page 1");
    expect(mocks.markSeen).not.toHaveBeenCalled();
    expect(mocks.testChannel).not.toHaveBeenCalled();
  });

  it("does not show the previous page as a failed new page, and lets users go back", async () => {
    mocks.listDeliveries
      .mockResolvedValueOnce({ deliveries: Array.from({ length: 26 }, (_, index) => delivery({ id: String(index), lastError: "first page" })) })
      .mockRejectedValueOnce(new Error("page unavailable"))
      .mockResolvedValueOnce({ deliveries: [delivery()] });
    await render();
    await act(async () => button("Next").click());
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.textContent).not.toContain("first page");
    expect(button("Next").disabled).toBe(true);
    await act(async () => button("Previous").click());
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelectorAll("li")).toHaveLength(1);
  });

  it("reads a page across channel kinds, shows registry labels, statuses, provider marks and timestamps without mutations", async () => {
    const kinds = ["slack", "discord", "msteams", "telegram", "email", "webhook", "in_app"];
    const statuses = ["sent", "queued", "sending", "failed", "seen"] as const;
    mocks.listDeliveries.mockResolvedValue({
      deliveries: kinds.map((kind, index) =>
        delivery({ id: String(index), channelKind: kind, status: statuses[index % 5] }),
      ),
    });
    await render();
    expect(mocks.listDeliveries).toHaveBeenCalledExactlyOnceWith({ limit: 26, before: undefined });
    expect(host.textContent).toContain("Deliveries across all channels.");
    expect(host.textContent).toContain("Deployment failed");
    for (const status of ["Sent", "Queued", "Sending", "Failed", "Seen"])
      expect(host.textContent).toContain(status);
    for (const name of Object.values(settings.notifications.kinds))
      expect(host.textContent).toContain(name);
    expect(host.querySelector('[data-logo="slack"]')).not.toBeNull();
    expect(host.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-11T10:00:00Z");
    expect(host.textContent).toContain("Attempts: 1");
    expect(mocks.markSeen).not.toHaveBeenCalled();
    expect(mocks.testChannel).not.toHaveBeenCalled();
    expect(host.querySelectorAll("button")).toHaveLength(1);
  });

  it("distinguishes loading from an empty history", async () => {
    const pending = deferred<{ deliveries: NotificationDelivery[] }>();
    mocks.listDeliveries.mockReturnValue(pending.promise);
    await render();
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      settings.notifications.deliveryHistory.loading,
    );
    expect(host.textContent).not.toContain(settings.notifications.deliveryHistory.empty);
    expect(host.querySelector("button")?.disabled).toBe(true);
    await act(async () => pending.resolve({ deliveries: [] }));
    expect(host.textContent).toContain(settings.notifications.deliveryHistory.empty);
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  it.each(["listDeliveries", "listCategories"] as const)(
    "shows %s failure distinctly and allows read-only refresh",
    async (method) => {
      mocks[method].mockRejectedValueOnce(new Error("private server detail"));
      await render();
      expect(host.querySelector('[role="alert"]')?.textContent).toBe(
        settings.notifications.deliveryHistory.error,
      );
      expect(host.textContent).not.toContain(settings.notifications.deliveryHistory.empty);
      expect(host.textContent).not.toContain("private server detail");
      await refresh();
      expect(host.querySelector('[role="alert"]')).toBeNull();
      expect(host.textContent).toContain(settings.notifications.deliveryHistory.empty);
      expect(mocks.listDeliveries).toHaveBeenCalledTimes(2);
      expect(mocks.markSeen).not.toHaveBeenCalled();
      expect(mocks.testChannel).not.toHaveBeenCalled();
    },
  );

  it("retains loaded rows with an explicit refresh error", async () => {
    mocks.listDeliveries
      .mockResolvedValueOnce({ deliveries: [delivery()] })
      .mockRejectedValueOnce(new Error("unavailable"));
    await render();
    await refresh();
    expect(host.textContent).toContain("Deployment failed");
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.textContent).not.toContain(settings.notifications.deliveryHistory.empty);
  });

  it.each(["user", "org", "cloud"] as const)(
    "clears private rows on %s change and ignores stale reads",
    async (key) => {
      const old = deferred<{ deliveries: NotificationDelivery[] }>();
      const current = deferred<{ deliveries: NotificationDelivery[] }>();
      mocks.listDeliveries
        .mockResolvedValueOnce({ deliveries: [delivery({ lastError: "private-old" })] })
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(current.promise);
      await render();
      expect(host.textContent).toContain("private-old");
      await refresh();
      mocks.scope[key] = "other";
      await render();
      expect(host.textContent).not.toContain("private-old");
      expect(host.querySelector('[role="status"]')).not.toBeNull();
      await act(async () =>
        current.resolve({ deliveries: [delivery({ lastError: "current-account" })] }),
      );
      await act(async () =>
        old.resolve({ deliveries: [delivery({ lastError: "private-stale" })] }),
      );
      expect(host.textContent).toContain("current-account");
      expect(host.textContent).not.toContain("private-stale");
    },
  );

  it("ignores a previous scope's read error", async () => {
    const old = deferred<{ deliveries: NotificationDelivery[] }>();
    mocks.listDeliveries.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ deliveries: [] });
    await render();
    mocks.scope.org = "other";
    await render();
    await act(async () => old.reject(new Error("old failure")));
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain(settings.notifications.deliveryHistory.empty);
  });

  it("renders sanitized backend details as plain text, and handles unknown registry entries", async () => {
    mocks.listDeliveries.mockResolvedValue({
      deliveries: [
        delivery({
          category: "retired",
          channelKind: "future",
          attempts: 0,
          lastError: '<img src=x onerror="alert(1)">',
        }),
      ],
    });
    await render();
    expect(host.querySelector("details")?.open).toBe(false);
    expect(host.querySelector("details")?.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("Unknown event");
    expect(host.textContent).toContain("Unknown channel");
    expect(host.textContent).not.toContain("Attempts:");
  });

  it("clears history on logout and does not fetch without a session", async () => {
    mocks.listDeliveries.mockResolvedValue({ deliveries: [delivery()] });
    await render();
    mocks.scope.user = "";
    await render();
    expect(host.textContent).toBe("");
    expect(mocks.listDeliveries).toHaveBeenCalledTimes(1);
  });
});
