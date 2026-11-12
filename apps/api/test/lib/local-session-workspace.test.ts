import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.CLOUD_MODE = "false";
  process.env.DEPLOY_MODE = "desktop";
  process.env.OPENSHIP_AUTH_MODE = "none";
  process.env.OPENSHIP_PUBLIC_URL = "";
  process.env.OPENSHIP_REQUIRE_AUTH = "false";
  process.env.BETTER_AUTH_SECRET = "local-workspace-test-secret-000000000000000000000000";
});

import { Hono } from "hono";
import { closeDb, db, eq, schema } from "@repo/db";
import { auth } from "@repo/platform/engine/lib/auth";
import { env } from "@repo/platform/engine/config/env";
import { ensureLocalUser } from "../../src/lib/local-user";
import { getSession, desktopLogin } from "../../src/modules/auth/auth.controller";

const teamId = "restored-shared-workspace";
const app = new Hono();
app.get("/api/auth/get-session", getSession);
app.get("/api/auth/desktop-login", desktopLogin);
app.all("/api/auth/organization/*", (c) => auth.handler(c.req.raw));
const localPeer = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
let userId: string;

beforeAll(async () => {
  userId = (await ensureLocalUser()).id;
  await db.insert(schema.organization).values({
    id: teamId, name: "Restored infrastructure", slug: teamId, isTeam: true,
  });
  await db.insert(schema.member).values({
    id: "restored-owner", userId, organizationId: teamId, role: "owner",
  });
  await db.insert(schema.servers).values({
    id: "restored-ssh", organizationId: teamId, name: "Restored SSH server", sshHost: "192.0.2.42",
  });
  await db.insert(schema.organization).values({
    id: "unrelated-team", name: "Another user's workspace", slug: "unrelated-team", isTeam: true,
  });
});
afterAll(() => closeDb());

function request(path: string, cookie?: string, peer = "127.0.0.1") {
  return app.request(`http://localhost:4000/api/auth/${path}`, {
    headers: cookie ? { cookie } : {},
  }, { incoming: { socket: { remoteAddress: peer } } });
}
function sessionCookie(response: Response) {
  return response.headers.getSetCookie().map(value => value.split(";")[0]!).join("; ");
}

it.each(["get-session", "desktop-login"])("opens the same restored workspace as cookie-free API access through %s", async (path) => {
  const response = await request(path);
  expect(response.status).toBe(path === "get-session" ? 200 : 302);
  const cookie = sessionCookie(response);
  expect(cookie).toContain("session_token=");
  const identity = await auth.api.getSession({ headers: new Headers({ cookie }) });
  expect(identity?.session.activeOrganizationId).toBe(teamId);
  expect(identity?.user.id).toBe(userId);
  const full = await request("organization/get-full-organization", cookie);
  expect(full.status).toBe(200);
  expect((await full.json()).id).toBe(teamId);
  const servers = await db.select().from(schema.servers)
    .where(eq(schema.servers.organizationId, identity!.session.activeOrganizationId!));
  expect(servers.map(server => server.id)).toEqual(["restored-ssh"]);
  if (path === "get-session") expect((await response.json()).session.activeOrganizationId).toBe(teamId);
});

it("preserves an explicitly selected personal workspace", async () => {
  const session = await request("get-session");
  const cookie = sessionCookie(session);
  const switched = await app.request("http://localhost:4000/api/auth/organization/set-active", {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ organizationId: `org_${userId}` }),
  }, localPeer);
  expect(switched.status).toBe(200);
  const personalCookie = sessionCookie(switched) || cookie;
  expect((await (await request("get-session", personalCookie)).json()).session.activeOrganizationId).toBe(`org_${userId}`);
  const login = await request("desktop-login", personalCookie);
  expect(login.status).toBe(302);
  expect(login.headers.getSetCookie()).toEqual([]);
  const identity = await auth.api.getSession({ headers: new Headers({ cookie: personalCookie }) });
  expect(identity?.session.activeOrganizationId).toBe(`org_${userId}`);
});

it("does not bootstrap an owner session for a remote peer", async () => {
  expect((await request("get-session", undefined, "192.0.2.10")).status).toBe(401);
});

it.each([
  { name: "Cloud", config: { CLOUD_MODE: true, DEPLOY_MODE: "cloud" as const, OPENSHIP_AUTH_MODE: "cloud" as const } },
  { name: "public instance", config: { OPENSHIP_PUBLIC_URL: "https://openship.example.test" } },
  { name: "forced-login instance", config: { OPENSHIP_REQUIRE_AUTH: true } },
])("cannot mint a local bootstrap session on a $name", async ({ config }) => {
  const previous = { ...env };
  const before = await db.select({ id: schema.session.id }).from(schema.session);
  try {
    Object.assign(env, config);
    const session = await request("get-session");
    expect(session.status).toBe(401);
    expect(session.headers.getSetCookie()).toEqual([]);
    const login = await request("desktop-login");
    expect(login.status).toBe(302);
    expect(login.headers.getSetCookie()).toEqual([]);
    expect(await db.select({ id: schema.session.id }).from(schema.session)).toEqual(before);
  } finally {
    Object.assign(env, previous);
  }
});
