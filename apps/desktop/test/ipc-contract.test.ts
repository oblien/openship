import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Static IPC-contract check between the Electron main process and the preload
 * bridge. The "Update now" bug that motivated this test was a renderer→main
 * gap; this guards the whole class: a preload `invoke`/`on` channel with no
 * corresponding main `handle`/`send` (or vice-versa) would let the dashboard
 * call into nothing. Pure text scan — no Electron runtime needed.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const main = read("../src/main/index.ts");
const preload = read("../src/preload/index.ts");

const matchAll = (src: string, re: RegExp) => [...src.matchAll(re)].map((m) => m[1]);

// Channels the MAIN process answers (invoke targets) or emits (events).
const handled = new Set([
  ...matchAll(main, /ipcMain\.handle\(\s*["'`]([^"'`]+)["'`]/g),
  ...matchAll(main, /ipcMain\.on\(\s*["'`]([^"'`]+)["'`]/g),
]);
const sent = new Set(matchAll(main, /\.send\(\s*["'`]([^"'`]+)["'`]/g));

// Channels the PRELOAD bridge invokes / subscribes to on behalf of the renderer.
const invoked = matchAll(preload, /ipcRenderer\.invoke\(\s*["'`]([^"'`]+)["'`]/g);
const listened = matchAll(preload, /ipcRenderer\.on\(\s*["'`]([^"'`]+)["'`]/g);

describe("preload ↔ main IPC contract", () => {
  it("every ipcRenderer.invoke() channel has a matching ipcMain.handle()", () => {
    const missing = invoked.filter((ch) => !handled.has(ch));
    expect(missing, `preload invokes channels with no main handler: ${missing.join(", ")}`).toEqual([]);
  });

  it("every ipcRenderer.on() channel is emitted by the main process", () => {
    const missing = listened.filter((ch) => !sent.has(ch));
    expect(missing, `preload listens for channels main never sends: ${missing.join(", ")}`).toEqual([]);
  });

  it("the updater channels are wired end to end (regression: 'Update now' no-op)", () => {
    for (const ch of ["update:check", "update:open", "update:start", "update:dismiss"]) {
      expect(handled.has(ch), `missing ipcMain.handle("${ch}")`).toBe(true);
      expect(invoked.includes(ch), `preload does not invoke "${ch}"`).toBe(true);
    }
    for (const ch of ["update:progress", "update:done", "update:error"]) {
      expect(sent.has(ch), `main never sends "${ch}"`).toBe(true);
      expect(listened.includes(ch), `preload does not listen for "${ch}"`).toBe(true);
    }
  });
});
