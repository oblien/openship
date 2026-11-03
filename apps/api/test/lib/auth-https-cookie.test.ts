import { afterAll, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DEPLOY_MODE = "desktop";
  process.env.OPENSHIP_AUTH_MODE = "local";
  process.env.OPENSHIP_PUBLIC_URL = "https://console.example.test";
  process.env.BETTER_AUTH_SECRET = "https-cookie-test-secret-01234567890123456789";
});

import { closeDb } from "@repo/db";
import { auth } from "@repo/platform/engine/lib/auth";

afterAll(() => closeDb());

it("shares HTTPS cookie policy without renaming existing self-hosted cookies", async () => {
  const context = await auth.$context;
  expect(context.authCookies.sessionToken.name).toBe("openship.session_token");
  expect(context.authCookies.sessionToken.attributes.secure).toBe(true);
  expect(context.createAuthCookie("state").attributes.secure).toBe(true);
});
