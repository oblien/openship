import { diagnosticId } from "@repo/core/diagnostics";
import { observeOperation } from "@repo/core/diagnostics/node";
import type { IpcMainInvokeEvent } from "electron";

/** Observe Electron's async response boundary without exposing IPC arguments. */
export function observeIpcHandler<T extends unknown[], R>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: T) => R,
): (event: IpcMainInvokeEvent, ...args: T) => Promise<Awaited<R>> {
  return (event, ...args) =>
    observeOperation<Awaited<R>>(
      {
        source: "desktop",
        kind: "operation",
        component: "desktop-ipc",
        operation: channel,
        requestId: diagnosticId(),
      },
      () => Promise.resolve(handler(event, ...args)),
    );
}
