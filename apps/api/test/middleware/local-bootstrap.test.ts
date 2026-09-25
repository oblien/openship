import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const h = vi.hoisted(() => ({
  env: { CLOUD_MODE: false, DEPLOY_MODE: "desktop", OPENSHIP_ALLOW_ZERO_AUTH: false,
    OPENSHIP_PUBLIC_URL: undefined as string | undefined, OPENSHIP_REQUIRE_AUTH: false },
  peer: "127.0.0.1" as string | undefined,
  users: [] as { id: string }[],
  listServers: vi.fn(async () => []),
  testConnection: vi.fn(async () => ({ ok: true, message: "Connected" })),
}));
vi.mock("@repo/platform/engine/config/env", () => ({ env: h.env, runtimeTargetId: "local" }));
vi.mock("@hono/node-server/conninfo", () => ({ getConnInfo: () => ({ remote: { address: h.peer } }) }));
vi.mock("@repo/db", () => ({
  db: { select: () => ({ from: () => ({ limit: async () => h.users }) }) },
  schema: { user: { id: "id" } }, repos: { server: { list: h.listServers } },
}));
vi.mock("@repo/platform/engine/lib/platform", () => ({ getPlatformKernel: vi.fn() }));
vi.mock("@repo/platform/engine/modules/system/server-check.operations", () => ({ runEphemeralConnectionTest: h.testConnection }));
vi.mock("@/lib/operation-context", () => ({}));
vi.mock("@/lib/operation-stream", () => ({}));

import { firstSignupGuard } from "@/middleware/local-bootstrap";
import { isAuthorizedLocalSignup } from "@repo/platform/engine/lib/local-bootstrap";
import { onboardingTestConnection } from "@/modules/system/server-check.controller";

const app = new Hono();
app.post("/sign-up/email", firstSignupGuard, c => c.json({ authorized: isAuthorizedLocalSignup() }));
app.post("/onboarding/test-connection", onboardingTestConnection);
const request = (path: string) => app.request(path, {
  method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.1", Host: "localhost" },
  body: JSON.stringify({ sshHost: "server.lan", sshPort: 22, sshUser: "root", sshAuthMethod: "password", sshPassword: "test" }),
});

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(h.env, { CLOUD_MODE: false, DEPLOY_MODE: "desktop", OPENSHIP_ALLOW_ZERO_AUTH: false,
    OPENSHIP_PUBLIC_URL: undefined, OPENSHIP_REQUIRE_AUTH: false });
  h.peer = "127.0.0.1";
  h.users = [];
});

describe("first-run authorization", () => {
  it.each(["203.0.113.4", undefined])("rejects a remote or unknown peer despite forged loopback headers: %s", async peer => {
    h.peer = peer;
    expect((await request("/sign-up/email")).status).toBe(403);
    expect((await request("/onboarding/test-connection")).status).toBe(404);
    expect(h.testConnection).not.toHaveBeenCalled();
    expect(h.listServers).not.toHaveBeenCalled();
  });

  it.each(["public", "cli", "unconfigured-local-posture"])("rejects a loopback proxy on %s instances", async posture => {
    if (posture === "public") h.env.OPENSHIP_PUBLIC_URL = "https://ops.example.test";
    if (posture === "cli") h.env.OPENSHIP_REQUIRE_AUTH = true;
    if (posture === "unconfigured-local-posture") h.env.DEPLOY_MODE = "docker";
    expect((await request("/sign-up/email")).status).toBe(403);
    expect((await request("/onboarding/test-connection")).status).toBe(404);
    expect(h.testConnection).not.toHaveBeenCalled();
  });

  it("allows the first desktop signup and scopes the database-hook authorization to that request", async () => {
    expect(isAuthorizedLocalSignup()).toBe(false);
    expect(await (await request("/sign-up/email")).json()).toEqual({ authorized: true });
    expect(isAuthorizedLocalSignup()).toBe(false);
    h.users = [{ id: "existing-user" }];
    expect((await request("/sign-up/email")).status).toBe(403);
  });

  it("retains explicitly enabled local onboarding and private-LAN SSH targets", async () => {
    h.env.DEPLOY_MODE = "bare";
    h.env.OPENSHIP_ALLOW_ZERO_AUTH = true;
    expect((await request("/onboarding/test-connection")).status).toBe(200);
    expect(h.testConnection).toHaveBeenCalledWith(expect.objectContaining({ sshHost: "server.lan" }));
  });

  it("preserves SaaS signup without opening its onboarding prober", async () => {
    h.env.CLOUD_MODE = true;
    h.peer = "203.0.113.4";
    expect((await request("/sign-up/email")).status).toBe(200);
    expect((await request("/onboarding/test-connection")).status).toBe(404);
    expect(h.testConnection).not.toHaveBeenCalled();
  });
});
