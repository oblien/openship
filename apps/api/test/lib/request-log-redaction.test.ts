import { describe, expect, it } from "vitest";
import { redactSensitiveRequestPath, sanitizeRequestLogLine } from "@/lib/request-log-redaction";

describe("request log redaction", () => {
  it("removes every query string from access logs", () => {
    expect(
      sanitizeRequestLogLine("--> GET /oauth/callback?code=secret&state=private 302 4ms"),
    ).toBe("--> GET /oauth/callback 302 4ms");
  });

  it("redacts invitation bearer tokens in incoming and outgoing log lines", () => {
    expect(
      sanitizeRequestLogLine(
        "<-- GET /api/auth/invitation-preview/AbC_123-secret?tracking=also-secret",
      ),
    ).toBe("<-- GET /api/auth/invitation-preview/:token");
    expect(sanitizeRequestLogLine("--> GET /accept-invite/AbC_123-secret 200 8ms")).toBe(
      "--> GET /accept-invite/:token 200 8ms",
    );
  });

  it("redacts error-handler paths without changing ordinary paths", () => {
    expect(redactSensitiveRequestPath("/api/auth/invitation-preview/secret-token")).toBe(
      "/api/auth/invitation-preview/:token",
    );
    expect(redactSensitiveRequestPath("/api/projects/prj_123")).toBe("/api/projects/prj_123");
  });
});
