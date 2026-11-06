// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { investigationHref } from "./investigation";
import {
  prepareInvestigationAutoSend,
  useInvestigationAutoSend,
} from "./use-investigation-auto-send";

type Props = Parameters<typeof useInvestigationAutoSend>[0];
const target = { kind: "deployment", deploymentId: "failed-build", projectId: "checkout" } as const;
const href = investigationHref(target, "user:workspace:cloud")!;
let root: Root, host: HTMLDivElement, props: Props, cancel: () => void;
function Harness() {
  cancel = useInvestigationAutoSend(props);
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
  prepareInvestigationAutoSend("");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  props = { href, ready: true, onSend: vi.fn().mockResolvedValue(true) };
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("leaves a valid URL editable unless an action staged this exact handoff", async () => {
  await render();
  expect(props.onSend).not.toHaveBeenCalled();
});

it("waits for connection and draft readiness, then sends once even in Strict Mode", async () => {
  prepareInvestigationAutoSend(href);
  await render({ ready: false });
  expect(props.onSend).not.toHaveBeenCalled();
  await render({ ready: true });
  expect(props.onSend).toHaveBeenCalledTimes(1);
  await render({ ready: false });
  await render({ ready: true });
  expect(props.onSend).toHaveBeenCalledTimes(1);
});

it("does not replay a completed or failed send on remount, back navigation or reconnect", async () => {
  prepareInvestigationAutoSend(href);
  props.onSend = vi.fn().mockResolvedValue(false);
  await render();
  await render({ href: null });
  await render({ href });
  await act(async () => root.render(null));
  await render();
  expect(props.onSend).toHaveBeenCalledTimes(1);
});

it("lets an edited draft, manual send or selected conversation cancel the queued send", async () => {
  prepareInvestigationAutoSend(href);
  await render({ ready: false });
  cancel();
  await render({ ready: true });
  expect(props.onSend).not.toHaveBeenCalled();
});

it("never transfers an intent to a different target, account, workspace or Cloud connection", async () => {
  for (const other of [
    investigationHref({ ...target, deploymentId: "different-build" }, "user:workspace:cloud"),
    investigationHref(target, "other:workspace:cloud"),
    investigationHref(target, "user:other:cloud"),
    investigationHref(target, "user:workspace:other"),
  ]) {
    prepareInvestigationAutoSend(href);
    await render({ href: other, ready: false });
    await render({ ready: true });
    await render({ href });
  }
  expect(props.onSend).not.toHaveBeenCalled();
});

it("discards a queued investigation when navigation changes before the provider is ready", async () => {
  prepareInvestigationAutoSend(href);
  await render({ ready: false });
  await render({ href: null });
  await render({ href, ready: true });
  expect(props.onSend).not.toHaveBeenCalled();
});

it("allows a fresh action after leaving the previous investigation", async () => {
  prepareInvestigationAutoSend(href);
  await render();
  await render({ href: null });
  prepareInvestigationAutoSend(href);
  await render({ href });
  expect(props.onSend).toHaveBeenCalledTimes(2);
});
