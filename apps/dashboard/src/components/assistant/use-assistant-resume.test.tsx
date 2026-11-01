// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AssistantConversation } from "@repo/contracts";
import { assistantResumeKey, useAssistantResume } from "./use-assistant-resume";

type Props = Parameters<typeof useAssistantResume>[0];
const chat = (id: string, updatedAt = "2026-10-30T12:00:00Z"): AssistantConversation => ({
  id,
  updatedAt,
  createdAt: updatedAt,
  title: id,
  provider: "codex",
  model: "",
  state: "done",
});
let root: Root, host: HTMLDivElement;
let props: Props;
let state: ReturnType<typeof useAssistantResume>;
const key = () => assistantResumeKey(props.scope, props.clientId, props.targetId);
function Harness() {
  state = useAssistantResume(props);
  return null;
}
async function render(changes: Partial<Props> = {}) {
  props = { ...props, ...changes };
  await act(async () => root.render(<Harness />));
}
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  props = {
    scope: "user-a:workspace-a:cloud-a",
    clientId: "client-a",
    targetId: "host-a",
    ready: true,
    search: "",
    chats: [chat("newest"), chat("visited", "2026-10-29T12:00:00Z")],
    loading: false,
    error: null,
    onResume: vi.fn(),
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

it("reopens the last visited chat only when it is in the authorized list", async () => {
  localStorage.setItem(key(), "visited");
  await render();
  expect(props.onResume).toHaveBeenCalledExactlyOnceWith("visited");
  expect(state.resolving).toBe(true);
  await render({ search: "chat=visited" });
  expect(state.resolving).toBe(false);
  state.remember("newest");
  expect(localStorage.getItem(key())).toBe("newest");
});

it("ignores stale or foreign IDs and falls back to the newest visible chat", async () => {
  localStorage.setItem(key(), "other-users-chat");
  await render();
  expect(props.onResume).toHaveBeenCalledExactlyOnceWith("newest");
});

it("keeps explicit new chats, deep links and investigation drafts in control", async () => {
  for (const search of ["new=1", "chat=visited", "investigate=deployment&project=app"])
    await render({ search });
  expect(props.onResume).not.toHaveBeenCalled();
  expect(state.resolving).toBe(false);
  await render({ search: "" });
  expect(props.onResume).toHaveBeenCalledExactlyOnceWith("newest");
});

it("waits for identity and isolates memories by account, workspace, connection and host", async () => {
  const originalKey = key();
  localStorage.setItem(originalKey, "visited");
  await render({ ready: false });
  state.remember("not-verified");
  expect(localStorage.getItem(originalKey)).toBe("visited");
  expect(props.onResume).not.toHaveBeenCalled();
  await render({
    ready: true,
    scope: "user-b:workspace-b:cloud-b",
    clientId: "client-b",
    targetId: "host-b",
    chats: null,
    loading: true,
  });
  expect(state.resolving).toBe(true);
  expect(props.onResume).not.toHaveBeenCalled();
  await render({ chats: [chat("their-chat")], loading: false });
  expect(props.onResume).toHaveBeenCalledExactlyOnceWith("their-chat");
  state.remember("their-chat");
  expect(localStorage.getItem(originalKey)).toBe("visited");
  expect(localStorage.getItem(key())).toBe("their-chat");
  expect(
    new Set([
      originalKey,
      assistantResumeKey("user-a:workspace-b:cloud-a", "client-a", "host-a"),
      assistantResumeKey("user-a:workspace-a:cloud-b", "client-a", "host-a"),
      assistantResumeKey("user-a:workspace-a:cloud-a", "client-b", "host-a"),
      assistantResumeKey("user-a:workspace-a:cloud-a", "client-a", "host-b"),
    ]).size,
  ).toBe(5);
});

it("does not steal a new-chat click when a delayed history response arrives", async () => {
  await render({ loading: true, chats: null });
  await act(async () => state.cancel());
  await render({ loading: false, chats: [chat("late")] });
  expect(props.onResume).not.toHaveBeenCalled();
  expect(state.resolving).toBe(false);
});

it("does not navigate away from a fresh composer on later background refreshes", async () => {
  await render({ chats: [] });
  expect(state.resolving).toBe(false);
  await render({ chats: [chat("background-task")] });
  expect(props.onResume).not.toHaveBeenCalled();
});

it("lets history failures recover without redirecting an in-progress draft", async () => {
  await render({ error: "Host unavailable", chats: null });
  expect(state.resolving).toBe(false);
  await render({ error: null, chats: [chat("recovered")] });
  expect(props.onResume).not.toHaveBeenCalled();
});

it("forgets only the deleted chat and tolerates unavailable browser storage", async () => {
  await render({ search: "new=1" });
  state.remember("visited");
  state.forget("another-chat");
  expect(localStorage.getItem(key())).toBe("visited");
  state.forget("visited");
  expect(localStorage.getItem(key())).toBeNull();
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("Storage disabled");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage disabled");
  });
  await render({ search: "" });
  expect(props.onResume).toHaveBeenCalledExactlyOnceWith("newest");
  expect(() => state.remember("newest")).not.toThrow();
});

it("keeps an explicit automation selection instead of replacing it with the last chat", async () => {
  localStorage.setItem(key(), "visited");
  await render({ search: "automation=flow-a" });
  expect(state.resolving).toBe(false);
  expect(props.onResume).not.toHaveBeenCalled();
});
