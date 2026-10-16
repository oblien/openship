import type { LogEntry, RuntimeAdapter } from "@repo/adapters";
import { disposeRuntime } from "./deployment-runtime";

/** Start a log stream that owns `runtime`: it is disposed on failure or on the first cleanup. */
export async function streamLogsOwningRuntime(
  runtime: RuntimeAdapter,
  containerId: string,
  onLog: (entry: LogEntry) => void,
  opts: { tail?: number } | undefined,
  serverId: string | null | undefined,
) {
  try {
    const stop = await runtime.streamRuntimeLogs(containerId, onLog, opts);
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      try {
        stop();
      } finally {
        disposeRuntime(runtime);
      }
    };
    return { cleanup, serverId };
  } catch (error) {
    disposeRuntime(runtime);
    throw error;
  }
}
