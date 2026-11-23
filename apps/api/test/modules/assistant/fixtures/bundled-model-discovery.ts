import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
// Follow the server's startup order for the shared app and its assistant consumers.
import { chatApps } from "../../../../src/modules/chat-apps/chat-apps.service";
import { assistantAutomations } from "../../../../src/modules/assistant/automation.service";
import { app } from "../../../../src/app";
import { assistant } from "../../../../src/modules/assistant/assistant.service";
import { db, schema } from "@repo/db";
import { auth } from "@repo/platform/engine/lib/auth";
import { env } from "@repo/platform/engine/config/env";
import { seedOrg } from "../../../helpers/seed";

assert.equal(typeof chatApps.start, "function");
assert.equal(typeof assistantAutomations.start, "function");

const owner = await seedOrg();
const token = randomUUID();
await db.insert(schema.session).values({
  id: randomUUID(),
  token,
  userId: owner.userId,
  activeOrganizationId: owner.organizationId,
  expiresAt: new Date(Date.now() + 60_000),
});
const signature = createHmac("sha256", env.BETTER_AUTH_SECRET).update(token).digest("base64");
const cookieName = (await auth.$context).authCookies.sessionToken.name;
const cookie = `${cookieName}=${encodeURIComponent(`${token}.${signature}`)}`;
const origin = "http://localhost:4000";

async function request(path: string, body?: object) {
  const response = await app.request(new URL(path, origin), {
    headers: { cookie, accept: "application/json", "content-type": "application/json" },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  assert.equal(response.status, 200, `${path} returned ${response.status}`);
  return response.json();
}

const { data: consent } = await request("/api/assistant/enable", {});
await request("/api/tokens/mcp-authorize", {
  clientId: consent.clientId,
  organizationId: owner.organizationId,
  fullAccess: true,
  readOnly: true,
  grants: [],
});
const grant = await request("/api/auth/oauth2/consent", {
  accept: true,
  oauth_query: consent.consentCode,
});
assert.deepEqual(await request(grant.url), { data: { enabled: true } });

// Stub the host discovery boundary. The compiled agent service must call this
// method on the same shared runtime after the real session and consent checks.
assistant.provider = async (_ctx, id) => ({
  id,
  name: id,
  installedVersion: "",
  available: false,
  issue: "Test provider is not installed",
  authStatus: { configured: false },
  authMethods: [],
  models: [],
  fields: [],
  settings: {},
});
const { data } = await request("/api/assistant/agents/models");
assert.deepEqual(
  data.providers.map((provider: { issue: string }) => provider.issue),
  ["Test provider is not installed", "Test provider is not installed"],
);
process.exit(0);
