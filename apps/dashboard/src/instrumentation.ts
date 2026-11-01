import { reportError } from "@repo/core/diagnostics";
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { installNodeErrorReporting } =
      await import("@repo/core/diagnostics/node");
    installNodeErrorReporting("dashboard");
  }
}

/** Next supplies route metadata separately; never log request headers/body. */
export function onRequestError(
  error: unknown,
  request: { method: string },
  context: { routePath: string },
) {
  reportError(error, {
    source: "dashboard",
    kind: "http",
    component: "dashboard-server",
    method: request.method,
    route: context.routePath,
    statusCode: 500,
    handled: true,
  });
}
