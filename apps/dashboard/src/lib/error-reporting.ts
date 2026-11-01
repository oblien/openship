import {
  diagnosticPath,
  diagnosticProperty,
  errorReporter,
  reportError,
  type ErrorContext,
  type ErrorSink,
} from "@repo/core/diagnostics";
import { getRestApiBaseUrl } from "./api/urls";

const observed = new WeakSet<object>();
let installed = false;

/** API errors already have an authoritative server event; retain its reference. */
export function reportClientError(
  error: unknown,
  context: ErrorContext = {},
): void {
  if (typeof window === "undefined" || !errorReporter.isEnabled()) return;
  const requestId = diagnosticProperty(error, "requestId");
  if (typeof requestId === "string" && /^[a-f0-9-]{36}$/i.test(requestId))
    return;
  if (error && typeof error === "object") {
    if (observed.has(error)) return;
    observed.add(error);
  }
  reportError(error, {
    source: "dashboard",
    kind: "client",
    component: "dashboard",
    route: diagnosticPath(window.location.pathname),
    handled: true,
    ...context,
  });
}

const sendClientErrors: ErrorSink = async (events, signal) => {
  if (!errorReporter.isEnabled()) return;
  const endpoint = `${getRestApiBaseUrl().replace(/\/$/, "")}/diagnostics/client-errors`;
  // Use raw fetch, never the API wrapper whose failure is itself observed.
  // Only this instance receives diagnostics; no analytics vendor is configured.
  for (let start = 0; start < events.length; start += 4) {
    if (!errorReporter.isEnabled() || signal.aborted) return;
    const payload = events.slice(start, start + 4).map((event) => ({
      name: event.error.name.slice(0, 80),
      message: event.error.message.slice(0, 2049),
      ...(event.context.component
        ? { component: event.context.component.slice(0, 160) }
        : {}),
      ...(event.error.stack ? { stack: event.error.stack.slice(0, 4097) } : {}),
      ...(event.error.code ? { code: event.error.code } : {}),
      ...(event.context.route
        ? { page: event.context.route.slice(0, 512) }
        : {}),
      ...(event.context.requestId
        ? { requestId: event.context.requestId }
        : {}),
      eventId: event.eventId,
    }));
    const response = await fetch(endpoint, {
      method: "POST",
      credentials: "include",
      redirect: "error",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: payload }),
      keepalive: true,
    });
    if (!response.ok) throw new Error("Diagnostic intake unavailable");
  }
};

/** Next instrumentation runs before hydration, including errors outside providers. */
export function installClientErrorReporting(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  errorReporter.setEnabled(
    () =>
      (window as Window & { __OPENSHIP_ERROR_REPORTING__?: boolean })
        .__OPENSHIP_ERROR_REPORTING__ === true,
  );
  errorReporter.setContextProvider(() => ({
    source: "dashboard",
    kind: "client",
    route: diagnosticPath(window.location.pathname),
  }));
  errorReporter.setSink(sendClientErrors);
  window.addEventListener("error", (event) => {
    // Resource load events have no Error object and may contain signed URLs.
    if (event instanceof ErrorEvent)
      reportClientError(event.error ?? event.message, { handled: false });
  });
  window.addEventListener("unhandledrejection", (event) =>
    reportClientError(event.reason, { handled: false }),
  );
  window.addEventListener("online", () =>
    errorReporter.setSink(sendClientErrors),
  );
  window.addEventListener("pagehide", () => {
    void errorReporter.flush(100);
  });
}
