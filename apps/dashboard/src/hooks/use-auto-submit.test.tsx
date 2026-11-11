// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAutoSubmitIntent, useAutoSubmit } from "./use-auto-submit";

type Props = Parameters<typeof useAutoSubmit>[0];
const key = "entry-a";
let root: Root, host: HTMLDivElement, props: Props, cancel: () => void;
function Harness() {
  cancel = useAutoSubmit(props);
  return null;
}
async function render(changes: Partial<Props> = {}) {
  props = { ...props, ...changes };
  await act(async () =>
    root.render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    ),
  );
}
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  props = { intent: createAutoSubmitIntent(), key, ready: true, onSubmit: vi.fn() };
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("does not submit from readiness alone without a prepared intent", async () => {
  await render();
  expect(props.onSubmit).not.toHaveBeenCalled();
});

it("waits for readiness, then submits once even in Strict Mode", async () => {
  props.intent.prepare(key);
  await render({ ready: false });
  expect(props.onSubmit).not.toHaveBeenCalled();
  await render({ ready: true });
  expect(props.onSubmit).toHaveBeenCalledTimes(1);
  await render({ ready: false });
  await render({ ready: true });
  expect(props.onSubmit).toHaveBeenCalledTimes(1);
});

it("does not retry a failed submission on remount, navigation or readiness changes", async () => {
  props.intent.prepare(key);
  props.onSubmit = vi.fn().mockResolvedValue(false);
  await render();
  await render({ key: null });
  await render({ key });
  await act(async () => root.render(null));
  await render();
  expect(props.onSubmit).toHaveBeenCalledTimes(1);
});

it("cancels a queued submission before it becomes ready", async () => {
  props.intent.prepare(key);
  await render({ ready: false });
  cancel();
  await render({ ready: true });
  expect(props.onSubmit).not.toHaveBeenCalled();
});

it("requires the exact entry key and discards a mismatched intent", async () => {
  props.intent.prepare(key);
  await render({ key: "entry-b" });
  await render({ key });
  expect(props.onSubmit).not.toHaveBeenCalled();
});

it("discards a queued submission when its entry is cleared before readiness", async () => {
  props.intent.prepare(key);
  await render({ ready: false });
  await render({ key: null });
  await render({ key, ready: true });
  expect(props.onSubmit).not.toHaveBeenCalled();
});

it("allows a fresh action after leaving the previous entry", async () => {
  props.intent.prepare(key);
  await render();
  await render({ key: null });
  props.intent.prepare(key);
  await render({ key });
  expect(props.onSubmit).toHaveBeenCalledTimes(2);
});

it("keeps independent flows from consuming each other's intent for the same key", async () => {
  const first = props.intent;
  const second = createAutoSubmitIntent();
  first.prepare(key);
  second.prepare(key);
  await render();
  await render({ intent: second });
  expect(props.onSubmit).toHaveBeenCalledTimes(2);
  await render({ intent: first });
  expect(props.onSubmit).toHaveBeenCalledTimes(2);
});

it("does not carry a queued submission into a different flow", async () => {
  props.intent.prepare(key);
  await render({ ready: false });
  await render({ intent: createAutoSubmitIntent(), ready: true });
  expect(props.onSubmit).not.toHaveBeenCalled();
});

it("does not let a stale cancel callback cancel a different entry", async () => {
  props.intent.prepare(key);
  await render({ ready: false });
  const cancelPrevious = cancel;
  props.intent.prepare("entry-b");
  await render({ key: "entry-b" });
  cancelPrevious();
  await render({ ready: true });
  expect(props.onSubmit).toHaveBeenCalledTimes(1);
});
