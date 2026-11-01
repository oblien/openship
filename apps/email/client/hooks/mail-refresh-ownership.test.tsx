import { afterEach, beforeEach, describe, expect, it, jest, mock, spyOn } from "bun:test";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
  onlineManager,
} from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { Provider, createStore } from "jotai";
import { initTRPC } from "@trpc/server";
import { Window } from "happy-dom";
import { act } from "react";
import { z } from "zod";
import * as authClient from "@/lib/auth-client";

let messages: Array<{ id: string; hasUnread: boolean }>;
let requests: number;
const t = initTRPC.create();
const router = t.router({
  mail: t.router({
    listThreads: t.procedure
      .input(
        z.object({
          folder: z.string().optional(),
          q: z.string().optional(),
          labelIds: z.array(z.string()).optional(),
          cursor: z.string().optional(),
        }),
      )
      .query(() => {
        requests++;
        return { threads: messages, nextPageToken: null };
      }),
  }),
});
let trpc: ReturnType<typeof createTRPCOptionsProxy<typeof router>>;

// Keep the real React, Query, Jotai, and tRPC query-key behavior. Only the
// surrounding account/router UI and the external mailbox transport are replaced.
mock.module("@/providers/query-provider", () => ({ useTRPC: () => trpc }));
mock.module("@/hooks/use-settings", () => ({ useSettings: () => ({ data: null }) }));
mock.module("react-router", () => ({ useParams: () => ({ folder: "inbox" }) }));
mock.module("nuqs", () => ({ useQueryState: () => [null, () => {}] }));
mock.module("next-themes", () => ({ useTheme: () => ({ theme: "light" }) }));

const { useThreads } = await import("./use-threads");
const { useMailRefresh } = await import("./use-mail-refresh");

class MailStream extends EventTarget {
  static instances: MailStream[] = [];
  closed = false;
  readyState = 0;
  constructor(readonly url: string) {
    super();
    MailStream.instances.push(this);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
}

let browser: Window;
let root: Root;
let container: HTMLElement;
let client: QueryClient;
const globals = new Map<string, PropertyDescriptor | undefined>();

function setGlobal(key: string, value: unknown) {
  globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

beforeEach(() => {
  // A module mock permanently removed signIn for tests loaded later. Replace
  // only the session hook and restore it, keeping the real auth API available.
  spyOn(authClient, "useSession").mockReturnValue({ data: null, isPending: false, refetch: async () => {} });
  browser = new Window({ url: "https://mail.openship.test/mail/inbox" });
  setGlobal("window", browser);
  setGlobal("document", browser.document);
  setGlobal("navigator", browser.navigator);
  setGlobal("EventSource", MailStream);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  jest.useFakeTimers();
  focusManager.setFocused(true);
  onlineManager.setOnline(true);
  MailStream.instances = [];
  messages = [];
  requests = 0;
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  trpc = createTRPCOptionsProxy({ router, ctx: () => ({}), queryClient: client });
  client.setQueryData(
    trpc.mail.listThreads.infiniteQueryKey({ folder: "inbox", q: "", labelIds: [] }),
    { pages: [{ threads: [], nextPageToken: null }], pageParams: [""] },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
  jest.useRealTimers();
  await browser.happyDOM.close();
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  globals.clear();
  mock.restore();
});

function ThreadConsumer() {
  const [, threads] = useThreads();
  return <output>{threads.map((thread) => thread.id).join(",")}</output>;
}

function Mailbox({ folder = "inbox" }: { folder?: string }) {
  useMailRefresh(true, folder);
  return Array.from({ length: 5 }, (_, index) => <ThreadConsumer key={index} />);
}

describe("mailbox refresh ownership", () => {
  it("closes the previous folder stream on navigation and every stream on unmount", async () => {
    const store = createStore();
    const render = (folder: string) => root.render(
      <Provider store={store}>
        <QueryClientProvider client={client}><Mailbox folder={folder} /></QueryClientProvider>
      </Provider>,
    );
    await act(async () => render("inbox"));
    const first = MailStream.instances[0]!;
    await act(async () => render("sent"));
    expect(first.closed).toBe(true);
    expect(MailStream.instances.filter(stream => !stream.closed)).toHaveLength(1);
    expect(MailStream.instances[1]!.url).toBe("https://mail.openship.test/mail/idle?view=sent");
    await act(async () => root.unmount());
    expect(MailStream.instances.every(stream => stream.closed)).toBe(true);
  });

  it("shares one live stream across mounted thread consumers and renders delivery immediately", async () => {
    await act(async () =>
      root.render(
        <Provider store={createStore()}>
          <QueryClientProvider client={client}>
            <Mailbox />
          </QueryClientProvider>
        </Provider>,
      ),
    );
    messages = [{ id: "arrived-while-open", hasUnread: true }];
    await act(async () => {
      MailStream.instances[0]!.dispatchEvent(new Event("mailbox"));
      for (let i = 0; i < 30; i++) await Promise.resolve();
      // Flush the query observer's scheduled React notification too.
      jest.advanceTimersByTime(1);
    });

    expect(requests).toBe(1);
    expect([...container.querySelectorAll("output")].map((node) => node.textContent)).toEqual(
      Array(5).fill("arrived-while-open"),
    );
    expect(MailStream.instances.filter((stream) => !stream.closed)).toHaveLength(1);
    expect(MailStream.instances[0]!.url).toBe("https://mail.openship.test/mail/idle?view=inbox");
  });
});
