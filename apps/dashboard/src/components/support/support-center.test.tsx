// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOUD_SUPPORT_ACCOUNT_HEADER,
  type CloudSupportSession,
  type CloudSupportCustomerDetail,
  type CloudSupportCustomerTicket,
} from "@repo/contracts";
import { I18nProvider } from "@/components/i18n-provider";
import { PlatformProvider } from "@/context/PlatformContext";
import { AuthProvider } from "@/context/AuthContext";
import { baseDictionary } from "@/i18n";
import { SupportCenter } from "./SupportCenter";

const h = vi.hoisted(() => ({
  query: "",
  replace: vi.fn(),
  fetch: vi.fn(),
  cloud: { connected: false, loading: false, cloudUser: null as { email: string } | null },
  account: null as CloudSupportSession["account"],
  user: { id: "customer-a", name: "Customer", email: "customer@example.test" } as {
    id: string;
    name: string;
    email: string;
  } | null,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: h.replace }),
  useSearchParams: () => new URLSearchParams(h.query),
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    scroll: _scroll,
    ...props
  }: {
    href: string;
    children: ReactNode;
    scroll?: boolean;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: h.user ? { user: h.user } : null, isPending: false }),
}));
vi.mock("@/context/CloudContext", () => ({ useCloud: () => h.cloud }));

const copy = baseDictionary.support;
const ticket = (n = 1): CloudSupportCustomerTicket => ({
  id: `SUP-${String(n).padStart(24, "0")}`,
  subject: `Deployment question ${n}`,
  category: "deployment",
  status: "open",
  createdAt: "2026-10-06T09:00:00Z",
  updatedAt: "2026-10-06T09:30:00Z",
});
const detail = (n = 1): CloudSupportCustomerDetail => ({
  ticket: { ...ticket(n), message: "My deployment needs help. <img src=x onerror=alert(1)>" },
  messages: [
    {
      id: `reply-${n}`,
      author: "support",
      body: "Please share the deployment reference.",
      createdAt: "2026-10-06T09:30:00Z",
    },
  ],
});
let root: Root;
let host: HTMLDivElement;
const render = (selfHosted = false, deployMode = "docker") =>
  act(async () =>
    root.render(
      <I18nProvider>
        <AuthProvider initialUser={h.user ? { ...h.user, emailVerified: true } : null}>
          <PlatformProvider
            key={`${selfHosted}:${deployMode}`}
            selfHosted={selfHosted}
            deployMode={deployMode}
          >
            <SupportCenter />
          </PlatformProvider>
        </AuthProvider>
      </I18nProvider>,
    ),
  );
const navigate = async (query: string) => {
  h.query = query;
  await render();
};
const click = (label: string) =>
  act(async () => {
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent?.trim() === label,
    );
    expect(button, label).toBeDefined();
    button!.click();
  });
async function fill(label: string, value: string) {
  const labelNode = [...host.querySelectorAll("label")].find((node) => node.textContent === label);
  const input = (
    labelNode
      ? document.getElementById(labelNode.htmlFor)
      : host.querySelector(`[aria-label="${label}"]`)
  ) as HTMLInputElement | HTMLTextAreaElement;
  expect(input, label).not.toBeNull();
  await act(async () => {
    const prototype =
      input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const submit = () =>
  act(async () => {
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
const posts = () => h.fetch.mock.calls.filter(([, init]) => init.method === "POST");
const reads = () => h.fetch.mock.calls.filter(([, init]) => init.method === "GET");
function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve: (value: T) => resolve(value),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  h.query = "";
  h.user = { id: "customer-a", name: "Customer", email: "customer@example.test" };
  h.cloud = { connected: false, loading: false, cloudUser: null };
  h.account = {
    id: "cloud-a",
    key: "linked-account-a",
    name: "Cloud customer",
    email: "cloud-customer@example.test",
  };
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", h.fetch);
  h.fetch.mockImplementation(async (url: URL, init: RequestInit) => {
    if (url.pathname.endsWith("/session")) return Response.json({ account: h.account });
    if (url.pathname.endsWith("/mine"))
      return Response.json(
        init.method === "POST"
          ? { id: ticket().id, createdAt: ticket().createdAt }
          : { tickets: [ticket()], nextCursor: null },
      );
    return Response.json(detail(Number(url.pathname.split("/").at(-1)?.replace("SUP-", "")) || 1));
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("private Cloud support center", () => {
  it("hydrates the server-authenticated page when the browser session is already loaded", async () => {
    const user = { ...h.user!, emailVerified: true };
    const tree = (
      <I18nProvider>
        <AuthProvider initialUser={user}>
          <PlatformProvider selfHosted={false}>
            <SupportCenter />
          </PlatformProvider>
        </AuthProvider>
      </I18nProvider>
    );
    h.user = null;
    const html = renderToString(tree);
    await act(async () => root.unmount());
    host.innerHTML = html;
    h.user = user;
    const recovered = vi.fn();
    await act(async () => {
      root = hydrateRoot(host, tree, { onRecoverableError: recovered });
    });
    expect(recovered).not.toHaveBeenCalled();
    expect(host.querySelector("h1")?.textContent).toBe(copy.title);
    expect(host.textContent).toContain(ticket().subject);
  });

  it("uses the signed-in session and leaves tickets unavailable on anonymous Cloud views", async () => {
    h.user = null;
    await render();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(host.textContent).toContain(copy.signIn);
    h.user = { id: "customer-b", name: "Other", email: "other@example.test" };
    await render();
    const [url, init] = h.fetch.mock.calls[0]!;
    expect(url.pathname).toBe("/api/cloud/support/mine");
    expect(init.credentials).toBe("include");
    expect(init.cache).toBe("no-store");
    expect(new Headers(init.headers).get(CLOUD_SUPPORT_ACCOUNT_HEADER)).toBe("customer-b");
    expect(host.textContent).toContain(ticket().subject);
  });

  it("shows the conversation as text and provides a direct ticket reference", async () => {
    await navigate(`ticket=${ticket().id}`);
    expect(host.querySelector("h2[id]")?.textContent).toBe(ticket().subject);
    expect(host.textContent).toContain(detail().ticket.message);
    expect(host.querySelector("img[onerror]")).toBeNull();
    expect(host.textContent).toContain(copy.team);
    expect(
      host.querySelector(`a[href="/support?ticket=${ticket().id}"]`)?.getAttribute("aria-current"),
    ).toBe("page");
  });

  it("keeps a failed new ticket and retries the same content and request ID", async () => {
    await navigate("new=1&topic=billing");
    await fill(copy.subjectLabel, "Checkout needs help");
    await fill(copy.messageLabel, "Payment completed but setup did not.");
    h.fetch.mockRejectedValueOnce(new TypeError("Connection lost"));
    await submit();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(copy.createFailed);
    expect(host.querySelector("textarea")?.value).toBe("Payment completed but setup did not.");
    expect(h.replace).not.toHaveBeenCalled();
    await submit();
    expect(posts()).toHaveLength(2);
    expect(posts()[1]![1].body).toBe(posts()[0]![1].body);
    expect(JSON.parse(posts()[0]![1].body)).toEqual({
      subject: "Checkout needs help",
      message: "Payment completed but setup did not.",
      category: "billing",
      requestId: expect.any(String),
    });
    expect(h.replace).toHaveBeenCalledExactlyOnceWith(`/support?ticket=${ticket().id}`, {
      scroll: false,
    });
  });

  it("does not duplicate a pending submit or navigate after the customer left the form", async () => {
    await navigate("new=1");
    await fill(copy.subjectLabel, "Build error");
    await fill(copy.messageLabel, "Please help.");
    const pending = deferred<Response>();
    h.fetch.mockReturnValueOnce(pending.promise);
    await submit();
    await submit();
    expect(posts()).toHaveLength(1);
    await navigate("");
    await act(async () =>
      pending.resolve(Response.json({ id: ticket().id, createdAt: ticket().createdAt })),
    );
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("resolves and reopens a conversation using the server response", async () => {
    await navigate(`ticket=${ticket().id}`);
    h.fetch.mockImplementationOnce(async (_url, init) => {
      expect(init.method).toBe("PATCH");
      expect(JSON.parse(init.body)).toEqual({ status: "resolved" });
      return Response.json({ ...detail(), ticket: { ...detail().ticket, status: "resolved" } });
    });
    await click(copy.markResolved);
    expect(host.textContent).toContain(copy.reopenHint);
    h.fetch.mockImplementationOnce(async (_url, init) => {
      expect(JSON.parse(init.body)).toEqual({ status: "open" });
      return Response.json(detail());
    });
    await click(copy.reopen);
    expect(host.textContent).not.toContain(copy.reopenHint);
  });

  it("preserves a failed reply, deduplicates retries, and reopens with the returned conversation", async () => {
    await navigate(`ticket=${ticket().id}`);
    await fill(copy.replyLabel, "Here is the reference: dep-customer.");
    h.fetch.mockRejectedValueOnce(new TypeError("Reply response lost"));
    await submit();
    expect(host.textContent).toContain(copy.replyFailed);
    expect(host.querySelector("textarea")?.value).toContain("dep-customer");
    h.fetch.mockResolvedValueOnce(
      Response.json({
        ...detail(),
        messages: [
          ...detail().messages,
          {
            id: "customer-reply",
            author: "customer",
            body: "Here is the reference: dep-customer.",
            createdAt: ticket().updatedAt,
          },
        ],
      }),
    );
    await submit();
    expect(posts()[1]![1].body).toBe(posts()[0]![1].body);
    expect(host.querySelector("textarea")?.value).toBe("");
    expect(host.querySelector("ol")?.textContent).toContain("Here is the reference: dep-customer.");
  });

  it("keeps confirmed data and the draft when refreshing fails", async () => {
    await navigate(`ticket=${ticket().id}`);
    await fill(copy.replyLabel, "Unsent details");
    h.fetch.mockRejectedValueOnce(new TypeError("Offline"));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(host.textContent).toContain(copy.threadFailed);
    expect(host.querySelector("ol")?.textContent).toContain(detail().ticket.message);
    expect(host.querySelector("textarea")?.value).toBe("Unsent details");
  });

  it("ignores a poll started before a status change", async () => {
    await navigate(`ticket=${ticket().id}`);
    const pending = deferred<Response>();
    h.fetch.mockReturnValueOnce(pending.promise);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    h.fetch.mockResolvedValueOnce(
      Response.json({ ...detail(), ticket: { ...detail().ticket, status: "resolved" } }),
    );
    await click(copy.markResolved);
    await act(async () => pending.resolve(Response.json(detail())));
    expect(host.textContent).toContain(copy.reopenHint);
  });

  it("ignores an old conversation response after choosing a different ticket", async () => {
    await render();
    const pending = deferred<Response>();
    h.fetch.mockReturnValueOnce(pending.promise);
    await navigate(`ticket=${ticket().id}`);
    await navigate(`ticket=${ticket(2).id}`);
    await act(async () => pending.resolve(Response.json(detail())));
    expect(host.querySelector("h2[id]")?.textContent).toBe(ticket(2).subject);
  });

  it("does not reuse in-flight private reads or drafts across accounts", async () => {
    const pending = deferred<Response>();
    h.fetch.mockReturnValueOnce(pending.promise);
    await render();
    h.user = { id: "customer-b", name: "Other", email: "other@example.test" };
    h.fetch.mockResolvedValueOnce(Response.json({ tickets: [ticket(2)], nextCursor: null }));
    await render();
    expect(reads()).toHaveLength(2);
    await act(async () =>
      pending.resolve(Response.json({ tickets: [ticket()], nextCursor: null })),
    );
    expect(host.textContent).toContain(ticket(2).subject);
    expect(host.textContent).not.toContain(ticket().subject);
    await navigate("new=1");
    await fill(copy.messageLabel, "Private unsent message");
    h.user = { id: "customer-c", name: "Third", email: "third@example.test" };
    await render();
    expect(host.querySelector("textarea")?.value).toBe("");
  });

  it("filters, searches, and appends the next page without losing earlier tickets", async () => {
    h.fetch.mockResolvedValueOnce(Response.json({ tickets: [ticket()], nextCursor: ticket().id }));
    await render();
    h.fetch.mockResolvedValueOnce(Response.json({ tickets: [ticket(2)], nextCursor: null }));
    await click(copy.loadMore);
    expect(reads().at(-1)![0].searchParams.get("before")).toBe(ticket().id);
    expect(host.textContent).toContain(ticket().subject);
    expect(host.textContent).toContain(ticket(2).subject);
    await click(copy.status.resolved);
    expect(reads().at(-1)![0].searchParams.get("status")).toBe("resolved");
    vi.useFakeTimers();
    await fill(copy.search, "100% build");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(reads().at(-1)![0].searchParams.get("search")).toBe("100% build");
    expect(reads().at(-1)![0].searchParams.has("before")).toBe(false);
  });

  it("offers recovery for missing or malformed responses instead of a success state", async () => {
    h.fetch.mockResolvedValueOnce(Response.json({ unexpected: "not a ticket list" }));
    await render();
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    await click(copy.retry);
    expect(host.textContent).toContain(ticket().subject);
    h.fetch.mockResolvedValueOnce(Response.json({ error: "Ticket not found" }, { status: 404 }));
    await navigate(`ticket=${ticket(3).id}`);
    expect(host.textContent).toContain(copy.threadFailed);
    expect(host.querySelector("form")).toBeNull();
  });
});

describe("Support on a Cloud-connected self-hosted installation", () => {
  beforeEach(() => {
    h.cloud = { connected: true, loading: false, cloudUser: { email: "team-owner@example.test" } };
  });

  it("uses the personal Cloud email and bound account for a new ticket", async () => {
    h.query = "new=1&topic=billing";
    await render(true);
    expect(host.textContent).toContain("cloud-customer@example.test");
    expect(host.textContent).not.toContain("Replies go to customer@example.test.");
    expect(host.textContent).not.toContain("team-owner@example.test");
    await fill(copy.subjectLabel, "Billing question");
    await fill(copy.messageLabel, "Please check my Cloud project.");
    await submit();
    expect(posts()).toHaveLength(1);
    const [url, init] = posts()[0]!;
    expect(url.pathname).toBe("/api/cloud/support/mine");
    expect(new Headers(init.headers).get(CLOUD_SUPPORT_ACCOUNT_HEADER)).toBe("linked-account-a");
    expect(new Headers(init.headers).has("Authorization")).toBe(false);
    expect(JSON.parse(init.body)).not.toHaveProperty("email");
    expect(h.replace).toHaveBeenCalledWith(`/support?ticket=${ticket().id}`, { scroll: false });
  });

  it("offers Cloud sign-in to a teammate without loading the shared owner's tickets", async () => {
    h.account = null;
    await render(true);
    expect(host.textContent).toContain(copy.teamConnectionDescription);
    expect(host.querySelector('a[href="https://app.openship.io/support"]')?.textContent).toBe(
      copy.openCloud,
    );
    expect(host.querySelector("form")).toBeNull();
    expect(reads().map(([url]) => url.pathname)).toEqual(["/api/cloud/support/session"]);
    expect(host.textContent).not.toContain("team-owner@example.test");
  });

  it("uses the verified Cloud connection on desktop even without a browser login", async () => {
    h.user = null;
    await render(false, "desktop");
    expect(host.textContent).toContain(ticket().subject);
    expect(host.textContent).toContain("cloud-customer@example.test");
    expect(reads().some(([url]) => url.pathname === "/api/cloud/support/session")).toBe(true);
  });

  it("clears a previous Cloud account's conversation and ignores its late response after reconnecting", async () => {
    h.query = `ticket=${ticket().id}`;
    const pending = deferred<Response>();
    const fallback = h.fetch.getMockImplementation()!;
    h.fetch.mockImplementation((url: URL, init: RequestInit) => {
      if (
        url.pathname.endsWith(ticket().id) &&
        new Headers(init.headers).get(CLOUD_SUPPORT_ACCOUNT_HEADER) === "linked-account-a"
      )
        return pending.promise;
      return fallback(url, init);
    });
    await render(true);
    h.cloud.cloudUser = { email: "new-link@example.test" };
    h.account = {
      id: "cloud-b",
      key: "linked-account-b",
      name: "Other",
      email: "other-cloud@example.test",
    };
    await render(true);
    await act(async () =>
      pending.resolve(
        Response.json({
          ...detail(),
          ticket: { ...detail().ticket, subject: "Private old conversation" },
        }),
      ),
    );
    expect(host.textContent).not.toContain("Private old conversation");
    expect(host.textContent).toContain("other-cloud@example.test");
    expect(new Headers(reads().at(-1)![1].headers).get(CLOUD_SUPPORT_ACCOUNT_HEADER)).toBe(
      "linked-account-b",
    );
  });

  it("refreshes a rejected connection binding without submitting the old draft as the new account", async () => {
    h.query = "new=1";
    await render(true);
    await fill(copy.subjectLabel, "Private question for account A");
    await fill(copy.messageLabel, "Old account details");
    // A reconnect in another tab may precede CloudContext's next status refresh.
    h.account = {
      id: "cloud-b",
      key: "linked-account-b",
      name: "Other",
      email: "other-cloud@example.test",
    };
    h.fetch.mockResolvedValueOnce(
      Response.json(
        { code: "SUPPORT_ACCOUNT_CHANGED", error: "Connection changed" },
        { status: 409 },
      ),
    );
    await submit();
    expect(posts()).toHaveLength(1);
    expect(h.replace).not.toHaveBeenCalled();
    expect(host.querySelector("textarea")?.value).toBe("");
    expect(host.textContent).toContain("other-cloud@example.test");
    expect(new Headers(posts()[0]![1].headers).get(CLOUD_SUPPORT_ACCOUNT_HEADER)).toBe(
      "linked-account-a",
    );
  });

  it("recovers a failed connection check and preserves a draft during a later transient failure", async () => {
    h.query = "new=1";
    h.fetch.mockRejectedValueOnce(new TypeError("Cloud temporarily unreachable"));
    await render(true);
    expect(host.textContent).toContain(copy.connectionFailed);
    expect(host.querySelector("form")).toBeNull();
    await click(copy.retry);
    await fill(copy.messageLabel, "Keep this draft");
    h.fetch.mockRejectedValueOnce(new TypeError("Connection check interrupted"));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(host.querySelector("textarea")?.value).toBe("Keep this draft");
  });

  it("clears private data on disconnect and offers a route back to Cloud", async () => {
    await render(true);
    expect(host.textContent).toContain(ticket().subject);
    h.cloud.connected = false;
    h.cloud.cloudUser = null;
    h.account = null;
    await render(true);
    expect(host.textContent).not.toContain(ticket().subject);
    expect(host.textContent).toContain(copy.connectDescription);
    expect(host.querySelector('a[href="/settings"]')).not.toBeNull();
    expect(host.querySelector('a[href="https://app.openship.io/support"]')).not.toBeNull();
  });
});
