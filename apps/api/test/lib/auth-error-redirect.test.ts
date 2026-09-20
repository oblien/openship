import { describe, expect, it } from "vitest";
import { auth } from "@repo/platform/engine/lib/auth";
import { resolveDashboardPublicUrl } from "@repo/platform/engine/lib/public-url";

describe("Better Auth browser error redirect", () => {
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
