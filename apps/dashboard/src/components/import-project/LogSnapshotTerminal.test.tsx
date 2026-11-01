// @vitest-environment happy-dom
import { StrictMode, act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LogSnapshotTerminal } from "./LogSnapshotTerminal";

const h = vi.hoisted(() => ({ terminal: { write: vi.fn() } }));
vi.mock("./TerminalSurface", () => ({
  default: ({ onReady }: { onReady: (terminal: unknown) => void }) => {
    useEffect(() => { onReady(h.terminal); }, [onReady]);
    return <div data-terminal />;
  },
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const render = (logs: string) => act(async () => root.render(
  <StrictMode><LogSnapshotTerminal logs={logs} emptyLabel="Waiting for logs" /></StrictMode>,
));

it("writes initial and appended output exactly once, including across repeated snapshots", async () => {
  await render("Preparing\n");
  await render("Preparing\n");
  await render("Preparing\n\x1b[32mReady\x1b[0m\n");
  expect(h.terminal.write.mock.calls).toEqual([["Preparing\n"], ["\x1b[32mReady\x1b[0m\n"]]);
});

it("queues replacement and cleared snapshots after pending output", async () => {
  await render("Previous run\n");
  await render("New run\n");
  await render("");
  await render("Retry\n");
  expect(h.terminal.write.mock.calls).toEqual([
    ["Previous run\n"], ["\x1bcNew run\n"], ["\x1bc"], ["Retry\n"],
  ]);
});

it("shows the waiting message only while the current log snapshot is empty", async () => {
  await render("");
  expect(container.textContent).toContain("Waiting for logs");
  expect(h.terminal.write).not.toHaveBeenCalled();
  await render("Output\n");
  expect(container.textContent).not.toContain("Waiting for logs");
});
