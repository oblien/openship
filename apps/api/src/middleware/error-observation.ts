import {
  diagnosticId,
  errorReporter,
  reportError,
  type ErrorContext,
} from "@repo/core/diagnostics";
import { withErrorContext } from "@repo/core/diagnostics/node";
import type { Context, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";

const REQUEST_ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const responseReads = new Set<Promise<void>>();

function registeredRoute(c: Context): string {
  // The whole match is available before auth runs. routePath alone points at
  // the early middleware when a guard returns 401/403 without calling next().
  try {
    const routes = matchedRoutes(c);
    for (let i = routes.length - 1; i >= 0; i--) {
      if (routes[i]!.path !== "*") return routes[i]!.path;
    }
  } catch {
    // Independently tested handlers may supply a minimal Context.
  }
  return c.req.routePath && c.req.routePath !== "*"
    ? c.req.routePath
    : "[unmatched]";
}

/** Shutdown only: let bounded response readers enqueue before flushing events. */
export async function drainErrorResponses(): Promise<void> {
  await Promise.all(responseReads);
}

export function requestErrorContext(c: Context): ErrorContext {
  const ctx = c.get("ctx");
  return {
    source: "api",
    kind: "http",
    component: "http",
    requestId: c.get("diagnosticRequestId"),
    traceId: c.get("diagnosticRequestId"),
    ...(ctx ? { userId: ctx.userId, organizationId: ctx.organizationId } : {}),
    method: c.req.method,
    route: c.get("diagnosticRoute") ?? registeredRoute(c),
    statusCode: c.res.status,
  };
}

/** Used by the error serializer, including small routers mounted independently in tests. */
export function noteApiError(c: Context, error: unknown): void {
  c.set("diagnosticError", error);
  if (!c.get("diagnosticRequestId")) {
    const requestId = diagnosticId();
    c.set("diagnosticRequestId", requestId);
    c.header("X-Request-ID", requestId);
    reportError(error, {
      ...requestErrorContext(c),
      statusCode: undefined,
      handled: true,
    });
  }
}

/**
 * The outermost boundary captures thrown errors AND explicit error responses:
 * auth, permission denials, validators, rate limits, proxy responses and 404s.
 * No response body is awaited on the request's completion path.
 */
export const observeRequestErrors: MiddlewareHandler = async (c, next) => {
  const requestId = diagnosticId();
  const parent = c.req.header("X-Request-ID");
  const start = performance.now();
  const route = registeredRoute(c);
  c.set("diagnosticRequestId", requestId);
  c.set("diagnosticRoute", route);
  c.header("X-Request-ID", requestId);
  return withErrorContext(
    {
      source: "api",
      kind: "http",
      requestId,
      traceId: requestId,
      method: c.req.method,
      route,
      ...(parent && REQUEST_ID.test(parent) ? { parentRequestId: parent } : {}),
    },
    async () => {
      try {
        await next();
      } finally {
        try {
          // A raw/relayed response may have replaced the headers prepared earlier.
          c.header("X-Request-ID", requestId);
          if (errorReporter.isEnabled() && c.res.status >= 400) {
            const context: ErrorContext = {
              ...requestErrorContext(c),
              durationMs: Math.round(performance.now() - start),
              handled: true,
            };
            const error = c.get("diagnosticError") ?? c.error;
            if (error !== undefined) reportError(error, context);
            else if (
              responseReads.size < 16 &&
              c.res.headers.get("content-type")?.includes("application/json")
            ) {
              let response: Response | undefined;
              try {
                response = c.res.clone();
              } catch {
                /* Locked bodies still receive a status-only event. */
              }
              if (response) {
                const pending = responseFailure(response, context);
                responseReads.add(pending);
                void pending.finally(() => {
                  responseReads.delete(pending);
                });
              } else reportError(`HTTP ${c.res.status}`, context);
            } else reportError(`HTTP ${c.res.status}`, context);
          }
        } catch (error) {
          // Observation must not replace an application response, including a
          // WebSocket upgrade or a response with immutable headers.
          reportError(error, { component: "http-observer", handled: true });
        }
      }
    },
    true,
  );
};

async function responseFailure(
  response: Response,
  context: ErrorContext,
): Promise<void> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let text = "";
  try {
    reader = response.body?.getReader();
    if (reader) {
      await Promise.race([
        (async () => {
          const decoder = new TextDecoder();
          let bytes = 0;
          while (bytes <= 4096) {
            const part = await reader.read();
            if (part.done) {
              text += decoder.decode();
              return;
            }
            bytes += part.value.byteLength;
            if (bytes > 4096) {
              text = "";
              return;
            }
            text += decoder.decode(part.value, { stream: true });
          }
        })(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 250);
        }),
      ]);
    }
    let body: { error?: unknown; message?: unknown; code?: unknown } | null =
      null;
    try {
      body = JSON.parse(text);
    } catch {
      /* An HTML/proxy/truncated failure is still classified by status. */
    }
    const message =
      typeof body?.error === "string"
        ? body.error
        : typeof body?.message === "string"
          ? body.message
          : `HTTP ${context.statusCode}`;
    reportError(message, {
      ...context,
      ...(typeof body?.code === "string" && /^[\w.-]{1,100}$/.test(body.code)
        ? { code: body.code }
        : {}),
    });
  } catch {
    reportError(`HTTP ${context.statusCode}`, context);
  } finally {
    if (timer) clearTimeout(timer);
    // Cancelling a tee can wait for its peer. Never await that promise here.
    void reader?.cancel().catch(() => {});
  }
}
