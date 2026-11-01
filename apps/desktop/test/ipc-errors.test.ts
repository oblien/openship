import { errorReporter, type ErrorEvent } from "@repo/core/diagnostics";
import { beforeEach, expect, it } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { observeIpcHandler } from "../src/main/ipc-errors";

const events: ErrorEvent[] = [];
beforeEach(async () => {
  await errorReporter.flush();
  events.length = 0;
  errorReporter.setEnabled(true);
  errorReporter.setSink((batch) => {
    events.push(...batch);
  });
});

it("preserves IPC results and rejections without collecting arguments", async () => {
  const event = {} as IpcMainInvokeEvent;
  const ok = observeIpcHandler("config:get", (_event, key: string) =>
    key === "theme" ? "dark" : null,
  );
  expect(await ok(event, "theme")).toBe("dark");
  const error = new Error("Rejected");
  const fail = observeIpcHandler("config:set", (_event, _secret: string) => {
    throw error;
  });
  await expect(fail(event, "private-ipc-913")).rejects.toBe(error);
  await errorReporter.flush();
  expect(events).toHaveLength(1);
  expect(events[0]?.context).toMatchObject({
    source: "desktop",
    operation: "config:set",
  });
  expect(JSON.stringify(events)).not.toContain("private-ipc-913");
});
