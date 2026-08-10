/**
 * Consume a deployment's build-session SSE stream (GET /deployments/:id/stream)
 * and render it to the terminal. Shared by `deploy --watch` and `logs --follow`.
 *
 * The API's session-manager emits these events (see session-manager.ts):
 *   log            {type:"log", message, level}   — terminal output
 *   progress       step metadata                  — ignored here
 *   service-status per-service compose status     — ignored here
 *   ping           keep-alive                      — ignored
 *   complete       {success, message?}
 *   cancelled      {message}
 *   end            {status}                        — terminal, closes stream
 *   error          {error}                         — session not found
 */
import { sseRequest } from "./sse";
import { isJsonMode, info, ok, err } from "./output";

export interface StreamResult {
  status?: string;
  success?: boolean;
  message?: string;
  /** Services that ended in `failed` — set on a partial deploy (some services
   *  live, some failed) that the session still reports as "ready". */
  failedServices?: Array<{ id: string; name: string }>;
}

export async function streamDeploymentLogs(deploymentId: string): Promise<StreamResult> {
  const result: StreamResult = {};

  // Per-service outcomes (compose deploys). The build session's terminal status
  // is "ready" even when SOME services failed (the DB row carries the real
  // partial_failure), so without this the CLI would print "✓ ready" and hide it.
  const serviceStatuses = new Map<string, { name: string; status: string }>();
  let terminalPrinted = false;

  const finishAndReport = (): void => {
    if (terminalPrinted) return;
    terminalPrinted = true;
    const failed = [...serviceStatuses.entries()]
      .filter(([, s]) => s.status === "failed")
      .map(([id, s]) => ({ id, name: s.name }));
    if (failed.length > 0) {
      result.failedServices = failed;
      const names = failed.map((f) => f.name).join(", ");
      const ids = failed.map((f) => f.id).join(",");
      err(
        `\n⚠  ${failed.length} of ${serviceStatuses.size} service(s) failed to deploy: ${names}\n` +
          `   The others are live; each failed service keeps serving its PREVIOUS container.\n` +
          `   Retry only the failed ones (the rest stay untouched):\n` +
          `     openship deploy --service-ids ${ids}\n`,
      );
    } else if (result.success) {
      ok(`\n✓ ${result.message ?? "Deployment ready"}`);
    } else {
      err(`\n✗ ${result.message ?? "Deployment failed"}`);
    }
  };

  for await (const ev of sseRequest(`/deployments/${deploymentId}/stream`)) {
    if (ev.event === "ping") continue;

    let payload: Record<string, unknown> = {};
    try {
      payload = ev.data ? (JSON.parse(ev.data) as Record<string, unknown>) : {};
    } catch {
      // Non-JSON frames (shouldn't happen) — treat data as a raw line.
      if (ev.event === "log" && ev.data) process.stdout.write(ev.data);
      continue;
    }

    if (isJsonMode()) {
      // Machine-readable: one compact JSON object per event on stdout.
      process.stdout.write(JSON.stringify({ event: ev.event, ...payload }) + "\n");
    }

    switch (ev.event) {
      case "log": {
        // formatLogPayload already appends a trailing newline to line logs.
        const msg = String(payload.message ?? "");
        if (!isJsonMode() && msg) process.stdout.write(msg);
        break;
      }
      case "service-status": {
        const id = typeof payload.serviceId === "string" ? payload.serviceId : "";
        if (id) {
          serviceStatuses.set(id, {
            name: typeof payload.serviceName === "string" ? payload.serviceName : id,
            status: String(payload.status ?? ""),
          });
        }
        break;
      }
      case "complete": {
        result.success = payload.success === true;
        result.message = typeof payload.message === "string" ? payload.message : undefined;
        finishAndReport();
        break;
      }
      case "cancelled":
        result.status = "cancelled";
        info(`\n${(payload.message as string) ?? "Build cancelled"}`);
        break;
      case "end":
        result.status = (payload.status as string) ?? result.status;
        // Fallback if no `complete` fired (e.g. reconnect mid-stream) — still
        // surface a partial failure the session reported as a clean status.
        finishAndReport();
        return result;
      case "error":
        err(`\n${(payload.error as string) ?? "Stream error"}`);
        result.success = false;
        return result;
    }
  }
  return result;
}
