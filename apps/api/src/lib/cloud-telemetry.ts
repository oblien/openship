import { diagnostics } from "@repo/core/diagnostics";
import { resolveBytesMapTelemetry } from "./bytesmap-telemetry-config";
import type { BytesMapTelemetry } from "./bytesmap-telemetry";

let runtime: BytesMapTelemetry | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;

/** Called after configuration and the existing Cloud diagnostics destination are installed. */
export async function startCloudTelemetry(): Promise<BytesMapTelemetry | undefined> {
  if (runtime) return runtime;
  const { env } = await import("@repo/platform/engine/config/env");
  try {
    const config = resolveBytesMapTelemetry(env);
    if (!config) return;
    const { createBytesMapTelemetry } = await import("./bytesmap-telemetry");
    const { APP_VERSION } = await import("@repo/platform/engine/lib/app-version");
    runtime = createBytesMapTelemetry(config, APP_VERSION);
    runtime.install();
    runtime.observer.event("openship.control_plane.started", {
      source: "api",
      kind: "background",
      component: "server",
    });
    runtime.heartbeat();
    const active = runtime;
    heartbeat = setInterval(() => active.heartbeat(), 60_000);
    heartbeat.unref();
    return runtime;
  } catch {
    const failed = runtime;
    runtime = undefined;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    if (failed)
      void failed.close().catch(() => {
        /* diagnostics-ignore: failed telemetry initialization is reported once below. */
      });
    // diagnostics-ignore: configuration/exporter details can contain credentials.
    diagnostics.warn(
      "api/cloud-telemetry",
      "BytesMap telemetry could not start. Check the server-only Cloud telemetry configuration; local diagnostics remain available.",
    );
  }
}

export async function stopCloudTelemetry(deadlineMs = 2000): Promise<void> {
  const active = runtime;
  if (!active) return;
  runtime = undefined;
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = undefined;
  active.observer.event("openship.control_plane.stopped", {
    source: "api",
    kind: "background",
    component: "server",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await active.flush(deadlineMs);
    await Promise.race([
      active.close(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, deadlineMs);
        timer.unref();
      }),
    ]);
  } catch {
    // diagnostics-ignore: bounded shutdown must not delay process exit or leak exporter details.
    void active.close().catch(() => {
      /* diagnostics-ignore: the bounded exporter shutdown is already diagnosed locally. */
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
