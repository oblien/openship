import { afterAll, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DEPLOY_MODE = "desktop";
  process.env.OPENSHIP_AUTH_MODE = "local";
  process.env.OPENSHIP_PUBLIC_URL = "http://192.0.2.10:3001";
  process.env.BETTER_AUTH_SECRET = "http-bootstrap-test-secret-01234567890123456789";
});

import { closeDb } from "@repo/db";
import { auth } from "@repo/platform/engine/lib/auth";

afterAll(() => closeDb());

it("keeps authentication available with an HTTP public URL during setup", async () => {
  const context = await auth.$context;
  expect(context.baseURL).toBe("http://192.0.2.10:3001/api/auth");
  expect(context.authCookies.sessionToken.name).toBe("openship.session_token");
  expect(context.authCookies.sessionToken.attributes.secure).toBe(false);
  const response = await auth.handler(new Request("http://192.0.2.10:3001/api/auth/get-session"));
  expect(response.status).toBe(200);
  expect(await response.json()).toBeNull();
});
