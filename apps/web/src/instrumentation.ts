import { reportError } from "@repo/core/diagnostics";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { installNodeErrorReporting } =
      await import("@repo/core/diagnostics/node");
    installNodeErrorReporting("web");
  }
}

/** Next provides route metadata; support messages and request headers stay private. */
export function onRequestError(
  error: unknown,
  request: { method: string },
  context: { routePath: string },
) {
  reportError(error, {
    source: "web",
    kind: "http",
    component: "web-server",
    method: request.method,
    route: context.routePath,
    statusCode: 500,
    handled: true,
  });
}
