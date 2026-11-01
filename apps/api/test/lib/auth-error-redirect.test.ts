import { describe, expect, it } from "vitest";
import { auth } from "@repo/platform/engine/lib/auth";
import { resolveDashboardPublicUrl } from "@repo/platform/engine/lib/public-url";
import { consoleErrorSink, errorReporter, type ErrorEvent } from "@repo/core/diagnostics";
import { withErrorContext } from "@repo/core/diagnostics/node";

describe("Better Auth browser error redirect", () => {
  it("routes internally handled auth failures through the same redacted request context", async () => {
    const context = await auth.$context;
    await errorReporter.flush();
    const events: ErrorEvent[] = [];
    errorReporter.setEnabled(true);
    errorReporter.setSink((batch) => {
      events.push(...batch);
    });
    try {
      const failure = Object.assign(
        new Error("Authentication failed", {
          cause: new Error("Authorization: Bearer auth-private-913"),
        }),
        { request: { password: "password-private-913" } },
      );
      withErrorContext({ requestId: "auth-request-1" }, () => {
        context.logger.error("Plugin rejected authentication", failure);
      });
      await errorReporter.flush();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        severity: "error",
        error: { message: "Authentication failed", cause: { message: "[REDACTED HEADER]" } },
        context: { requestId: "auth-request-1", component: "auth" },
      });
      expect(events[0]!.error.stack).toBeTruthy();
      expect(JSON.stringify(events)).not.toMatch(/auth-private|password-private/);
    } finally {
      errorReporter.setEnabled(false);
      errorReporter.setSink(consoleErrorSink);
    }
  });

  it("sends OAuth failures to the public dashboard error page with their details", async () => {
    const response = await auth.handler(
      new Request(
        "http://localhost:4000/api/auth/error?error=invalid_client&error_description=Unknown%20client",
      ),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe(new URL(resolveDashboardPublicUrl()).origin);
    expect(location.pathname).toBe("/auth/error");
    expect(location.searchParams.get("error")).toBe("invalid_client");
    expect(location.searchParams.get("error_description")).toBe("Unknown client");
  });
});
