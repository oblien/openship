import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import IORedis from "ioredis";
import { env } from "../config/env";

export async function isRedisReachable(timeoutMs = 2000): Promise<boolean> {
  const probe = new IORedis(env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    enableReadyCheck: false,
    connectTimeout: timeoutMs,
  });
  // Connection failures are the expected negative result of this probe.
  // ioredis reports them both by rejecting connect()/ping() and by emitting an
  // `error` event; without a listener the latter becomes noisy "Unhandled error
  // event" stderr even though the rejection below is handled correctly.
  probe.on("error", (eventDiagnosticError) => { observeCaughtError(eventDiagnosticError, "platform/engine/lib/redis"); });
  try {
    await Promise.race([
      probe.connect(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), timeoutMs),
      ),
    ]);
    await probe.ping();
    return true;
  } catch (diagnosticFailure) {
    observeCaughtError(diagnosticFailure, "platform/engine/lib/redis");
    return false;
  } finally {
    try {
      probe.disconnect();
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "platform/engine/lib/redis");
      /* best-effort */
    }
  }
}
