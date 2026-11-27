import "../mail/_setup-env";
import { Hono } from "hono";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { db, repos, schema } from "@repo/db";
import { OblienError } from "@repo/adapters";
import { hashPatToken, PAT_PREFIX } from "@repo/platform/engine/lib/pat";
import { eq } from "drizzle-orm";
import { seedOwner } from "../jobs/_harness";
import { managedMailRoutes } from "../../../src/modules/managed-mail/managed-mail.routes";
import { mailAccountRoutes } from "../../../src/modules/mail/accounts.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import {
  paidEmailPlan,
  sendingNamespace,
} from "@repo/platform/engine/modules/managed-mail/billing";

const h = vi.hoisted(() => ({
  cloud: true,
  billingEnabled: true,
  hostedEnrollmentEnabled: true,
  forward: vi.fn(),
  grants: "{}",
  engines: "[]",
  fleet: undefined as string | undefined,
  namespaces: { get: vi.fn(), update: vi.fn() },
  vmCreate: vi.fn(),
  vmRead: vi.fn(),
  resize: vi.fn(),
  vmHandle: vi.fn(),
  dnsWrite: vi.fn(),
  prepare: vi.fn(),
  proof: vi.fn(),
  discoveryTxt: vi.fn(),
  discoveryMx: vi.fn(),
  mail: {
    tenants: { ensure: vi.fn(), getPolicy: vi.fn(), updatePolicy: vi.fn() },
    senders: { listUsage: vi.fn(), setCap: vi.fn(), clearCap: vi.fn() },
    domains: { listUsage: vi.fn(), setCap: vi.fn(), clearCap: vi.fn(), add: vi.fn(), list: vi.fn(), verify: vi.fn(), remove: vi.fn(), get: vi.fn() },
    keys: { list: vi.fn(), create: vi.fn(), revoke: vi.fn() },
    messages: { send: vi.fn(), get: vi.fn() },
  },
  provider: {
    assertMonthlyCapacitySupport: vi.fn(),
    previewPlanChange: vi.fn(),
    changePlan: vi.fn(),
    getPlanChange: vi.fn(),
    cancelPlanChange: vi.fn(),
    getCatalog: vi.fn(),
    createCheckout: vi.fn(),
    getCheckout: vi.fn(),
    cancelCheckout: vi.fn(),
    getSubscription: vi.fn(),
    getEntitlement: vi.fn(),
  },
}));
vi.mock("@repo/platform/engine/config/env", async (original) => {
  const actual = await original<typeof import("@repo/platform/engine/config/env")>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get CLOUD_MODE() {
        return h.cloud;
      },
      get OPENSHIP_MAIL_HOSTED_ENROLLMENT_ENABLED() {
        return h.hostedEnrollmentEnabled;
      },
      get BILLING_ENABLED() {
        return h.billingEnabled;
      },
      get OPENSHIP_MAIL_PLAN_GRANTS() {
        return h.grants;
      },
      get OPENSHIP_MAIL_DEDICATED_FLEET() {
        return h.fleet;
      },
      get OPENSHIP_MAIL_ENGINES() {
        return h.engines;
      },
    },
  };
});
vi.mock("@repo/platform/engine/lib/oblien-client", () => ({
  getOblienBillingApi: () => h.provider,
  getOblienClient: () => ({
    mail: h.mail,
    namespaces: h.namespaces,
    vms: { create: h.vmCreate, get: h.vmRead },
    vm: h.vmHandle,
  }),
}));
vi.mock("@repo/platform/engine/lib/cloud-docker-workspace", async (original) => ({
  ...(await original<object>()),
  resizeDockerWorkspace: h.resize,
}));
vi.mock("@repo/platform/engine/lib/oblien-namespace", () => ({ ensureCloudNamespace: h.prepare }));

vi.mock("@repo/platform/engine/lib/cloud/server-link", async (original) => ({
  ...(await original<object>()),
  linkedCloudIdentity: async (org: string) => ({ organizationId: org }),
  remoteCloudRequest: h.forward,
}));

vi.mock("@repo/platform/engine/modules/dns/registry", async (original) => ({
  ...(await original<object>()),
  resolveDnsProvider: () => ({ upsertRecord: h.dnsWrite }),
}));
vi.mock("node:dns/promises", async (original) => ({
  ...(await original<typeof import("node:dns/promises")>()),
  resolveTxt: h.proof,
  Resolver: class {
    resolveTxt = h.discoveryTxt;
    resolveMx = h.discoveryMx;
  },
}));

const app = new Hono<{ Variables: { clientIp: string } }>()
  .use("/api/mail/discovery", async (c, next) => {
    c.set("clientIp", "127.0.0.1");
    await next();
  })
  .onError(handleApiError)
  .route("/api/mail", managedMailRoutes)
  .route("/api/mail", mailAccountRoutes);
type Owner = Awaited<ReturnType<typeof seedOwner>>;
function call(owner: Owner, path: string, body?: object, method = body ? "POST" : "GET") {
  return app.request("/api/mail" + path, {
    headers: {
      ...owner.auth,
      "content-type": "application/json",
      "X-Organization-Id": owner.orgId,
    },
    method,
    body: body ? JSON.stringify(body) : undefined,
  });
}
beforeEach(() => {
  h.cloud = true;
  h.billingEnabled = true;
  h.hostedEnrollmentEnabled = true;
  h.engines = "[]";
  h.fleet = undefined;
  h.grants = "{}";
  h.provider.getCatalog.mockResolvedValue({ reseller: { serviceOffers: true } });
  h.provider.getSubscription.mockResolvedValue({ subscription: null });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it("forwards only declared Cloud operations from an unrestricted linked instance", async () => {
  h.cloud = false;
  const owner = await seedOwner({ instanceAdmin: true });
  const scoped = await seedOwner();
  h.forward.mockResolvedValue({ accepted: true });
  const path = "/sending/domains?ignored=private";
  const domain = { domain: "sender.example" };
  const response = await call(owner, path, domain);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ accepted: true });
  expect(h.forward).toHaveBeenCalledExactlyOnceWith(
    owner.orgId,
    "/api/mail/sending/domains",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(domain),
    },
    { organizationId: owner.orgId },
  );
  expect((await call(owner, "/sending/domains/invalid!")).status).toBe(400);
  expect((await call(owner, path, { domain: "!" })).status).toBe(400);
  expect((await call(scoped, path, domain)).status).toBe(409);
  expect(h.forward).toHaveBeenCalledTimes(1);
});

it.each([true, false])("discovers active hosted domains through the public route (shared=%s)", async shared => {
  const owner = await seedOwner();
  const id = "managed-mail-" + crypto.randomUUID();
  const engine = {
    serverId: "worker-" + id, origin: "https://worker.example.test", token: "private-worker-token",
    hostname: "mail." + id + ".test", webmailUrl: "https://webmail." + id + ".test",
    placement: shared ? "standard" as const : "dedicated" as const, prepare: false, shared,
  };
  const { engineIdentity } = await import("@repo/platform/engine/modules/managed-mail/service");
  await repos.managedMail.claim({ id, organizationId: owner.orgId, hostname: engine.hostname,
    engine: engineIdentity(engine), shared, placement: engine.placement });
  h.engines = JSON.stringify([engine]);
  const lookup = (domain = "inbox.example.test") => app.request("/api/mail/discovery?domain=" + encodeURIComponent(domain));
  h.discoveryTxt.mockResolvedValue([["openship-mail=", id]]);
  const worker = vi.fn(async () => Response.json({ domain: { domain: "inbox.example.test", active: true } }));
  vi.stubGlobal("fetch", worker);
  const res = await lookup();
  expect(res.status, await res.clone().text()).toBe(200);
  expect(await res.json()).toEqual({ webmailUrl: engine.webmailUrl });
  expect(worker).toHaveBeenCalledWith(new URL("/api/mail/admin/" + engine.serverId + "/domains/inbox.example.test", engine.origin),
    expect.objectContaining({ method: "GET", redirect: "error" }));
  expect(h.discoveryMx).not.toHaveBeenCalled();

  h.discoveryTxt.mockResolvedValue([]);
  h.discoveryMx.mockResolvedValue([{ priority: 10, exchange: engine.hostname + "." }]);
  expect((await lookup()).status).toBe(200);
  worker.mockResolvedValueOnce(Response.json({ domain: { domain: "inbox.example.test", active: false } }));
  expect((await lookup()).status).toBe(404);
  worker.mockResolvedValueOnce(new Response(null, { status: 404 }));
  expect((await lookup()).status).toBe(404);
  h.discoveryMx.mockResolvedValue([{ priority: 0, exchange: "unassigned.test" }]);
  expect((await lookup()).status).toBe(404);
  expect((await lookup("alex@inbox.example.test")).status).toBe(400);
  expect(worker).toHaveBeenCalledTimes(4);
  h.discoveryTxt.mockRejectedValue(Object.assign(new Error("DNS unavailable"), { code: "ETIMEOUT" }));
  expect((await lookup()).status).toBe(503);
  h.cloud = false;
  expect((await lookup()).status).toBe(404);
});

it("activates one private engine through the Cloud router and isolates its account API", async () => {
  const owner = await seedOwner(),
    other = await seedOwner();
  const grant = { plan: "team", until: new Date(Date.now() + 60_000).toISOString() };
  h.grants = JSON.stringify({ [owner.orgId]: grant, [other.orgId]: grant });
  const engine = {
    serverId: "worker-1",
    origin: "https://worker.example.test",
    token: "worker-test",
    hostname: "mail.slot.example.test",
    placement: "standard",
    webmailUrl: "https://mail.slot.example.test",
  };
  h.engines = JSON.stringify([engine]);
  const requests: string[] = [];
  const domains = [{ domain: "slot.example.test" }];
  const mailboxes: object[] = [];
  let settings: Record<string, string> | null = null;
  let relaySupported = false;
  const { cloudRuntimeTarget } = await import("@repo/core");
  let relayOrigin = "https://other-cloud.example.test";
  let relayKeyId: string | undefined;
  let nativeFailures = 2;
  let loseInstallReply = true;
  const fakeWorker = vi.fn(async (url: URL, init: RequestInit) => {
    expect(url.origin).toBe(engine.origin);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer worker-test");
    requests.push(init.method + " " + url.pathname);
    if (url.pathname.endsWith("/status"))
      return Response.json({
        serverId: engine.serverId,
        domain: "slot.example.test",
        finishedAt: Date.now(),
        engine: { running: true, flavor: "container" },
        webmail: { installed: true, projectId: "webmail", url: engine.webmailUrl },
      });
    if (url.pathname.endsWith("/webmail/hosting")) {
      expect(JSON.parse(String(init.body))).toEqual({
        namespace: sendingNamespace(owner.orgId),
        imapHost: engine.hostname,
      });
      return Response.json({ bound: true, apiRelay: true });
    }
    if (url.pathname.endsWith("/domains") && init.method === "POST") {
      const body = JSON.parse(String(init.body));
      expect(body.createPostmaster).toBe(false);
      domains.push({ domain: body.domain });
      return Response.json({ domain: { domain: body.domain } });
    }
    if (url.pathname.endsWith("/domains")) return Response.json({ domains });
    if (url.pathname.endsWith("/domains/customer.test"))
      return Response.json({ domain: { ...domains[1], active: true } });
    if (url.pathname.endsWith("/mailboxes")) {
      if (init.method !== "POST") return Response.json({ mailboxes });
      const body = JSON.parse(String(init.body));
      const mailbox = { username: body.localPart + "@" + body.domain, quotaMB: body.quotaMB };
      mailboxes.push(mailbox);
      return Response.json({ mailbox });
    }
    if (url.pathname.endsWith("/webmail/sending/customer.test")) {
      if (init.method === "PUT") {
        const input = JSON.parse(String(init.body));
        expect(input.apiOrigin).toBe(relayOrigin);
        settings = input;
        if (nativeFailures > 0) {
          nativeFailures--;
          return new Response(null, { status: 503 });
        }
        relayKeyId = input.keyId;
        if (loseInstallReply) {
          loseInstallReply = false;
          return new Response(null, { status: 503 });
        }
      }
      return Response.json({
        apiRelay: relaySupported, relayOrigin,
        sending: settings && { namespace: settings.namespace, keyId: settings.keyId,
          apiOrigin: relayOrigin, relayKeyId },
      });
    }
    throw new Error("Unexpected engine operation");
  });
  vi.stubGlobal("fetch", fakeWorker);
  expect((await call(owner, "/managed", { placement: "dedicated" })).status).toBe(402);
  const activate = () => call(owner, "/managed", { placement: "standard" });
  const responses = await Promise.all([activate(), activate()]);
  expect(responses.map((r) => r.status)).toEqual([200, 200]);
  const [first, second] = await Promise.all(responses.map((r) => r.json()));
  expect(first).toEqual(second);
  expect(requests.filter((p) => p.endsWith("/relay"))).toHaveLength(0);
  expect(await (await call(owner, "/managed")).json()).toMatchObject({
    plan: "team",
    service: { id: first.id },
  });
  expect(await (await call(owner, "/admin/" + first.id + "/domains")).json()).toEqual({
    domains: [],
  });
  const count = fakeWorker.mock.calls.length;
  expect([403, 404]).toContain((await call(other, "/admin/" + first.id + "/domains")).status);
  expect((await call(other, "/managed", { placement: "standard" })).status).toBe(503);
  expect(fakeWorker).toHaveBeenCalledTimes(count);

  const admin = "/admin/" + first.id;
  expect((await call(owner, admin + "/domains", { domain: "invalid" })).status).toBe(400);
  expect(h.proof).not.toHaveBeenCalled();
  h.proof.mockResolvedValueOnce([]).mockResolvedValueOnce([["openship-mail=" + first.id]]);
  expect((await call(owner, admin + "/domains", { domain: "customer.test" })).status).toBe(409);
  expect((await call(owner, admin + "/domains", { domain: "customer.test" })).status).toBe(201);
  const created = await call(owner, admin + "/mailboxes", {
    domain: "customer.test",
    localPart: "person",
    password: "test-mailbox-password",
  });
  expect(created.status).toBe(201);
  expect(await created.json()).toMatchObject({
    mailbox: { username: "person@customer.test", quotaMB: 5120 },
  });

  const namespace = sendingNamespace(owner.orgId);
  h.mail.tenants.ensure.mockResolvedValue({ namespace, holds: [] });
  h.mail.tenants.getPolicy.mockResolvedValue({ revision: 1 });
  h.mail.domains.get.mockResolvedValue({ domain: "customer.test", id: "verified", state: "ready" });
  const connect = () => call(owner, "/managed/" + first.id + "/sending/verified", {});
  expect((await connect()).status).toBe(409);
  expect(await repos.personalAccessToken.listMailSendKeys(owner.orgId)).toHaveLength(0);
  relaySupported = true;
  expect((await connect()).status).toBe(409);
  expect(await repos.personalAccessToken.listMailSendKeys(owner.orgId)).toHaveLength(0);
  relayOrigin = new URL(cloudRuntimeTarget.api).origin;
  const status = () => call(owner, "/managed/" + first.id + "/sending/verified");
  expect(await (await status()).json()).toEqual({ configured: false });
  // Webmail completed first. Its installed key stays usable during a Postfix failure.
  for (let i = 0; i < 2; i++) {
    expect((await connect()).status).toBe(502);
    expect(await repos.personalAccessToken.listMailSendKeys(owner.orgId)).toHaveLength(1);
  }
  expect(await (await status()).json()).toEqual({ configured: false });
  // On retry, both transports committed the new credential before the response was lost.
  expect(await (await connect()).json()).toEqual({ configured: true });
  expect(h.mail.tenants.updatePolicy).toHaveBeenCalledWith(
    namespace,
    expect.objectContaining({ period: 25000, daily: 2500, domains: 50, revision: 1 }),
  );
  expect(await (await connect()).json()).toEqual({ configured: true });
  expect(await repos.personalAccessToken.listMailSendKeys(owner.orgId)).toEqual([
    expect.objectContaining({ domainId: "verified", prefix: expect.stringMatching(/^opsh_pat_/) }),
  ]);
  expect(await (await status()).json()).toEqual({ configured: true });
  expect(h.mail.keys.create).not.toHaveBeenCalled();
  expect(h.mail.keys.revoke).not.toHaveBeenCalled();
});

it("recovers a lost checkout with its original key and grants only the verified owner and price", async () => {
  const owner = await seedOwner();
  const org = owner.orgId;
  const namespace = sendingNamespace(org);
  h.provider.createCheckout
    .mockRejectedValueOnce(new Error("lost response"))
    .mockResolvedValue({ checkoutId: "checkout", url: "https://checkout.example.test/pay" });
  h.provider.getCheckout.mockResolvedValue({ checkout: { status: "open" } });
  const purchase = () => call(owner, "/managed/checkout", { plan: "team" });
  expect((await purchase()).status).toBeGreaterThanOrEqual(500);
  const saved = await repos.managedMail.account(org);
  expect(saved?.checkout).toMatchObject({ plan: "team" });
  expect((await purchase()).status).toBe(200);
  const request = h.provider.createCheckout.mock.calls[0][0];
  expect(
    h.provider.createCheckout.mock.calls.every(
      ([next]) => next.idempotencyKey === saved?.checkout?.key,
    ),
  ).toBe(true);
  expect(request).toMatchObject({ namespace, offer: { billingMode: "service", unitAmount: 900 } });
  const periodStart = new Date(Date.now() - 10000).toISOString(),
    periodEnd = new Date(Date.now() + 86400000).toISOString();
  const subscription = { ...request, status: "active", periodStart, periodEnd };
  h.provider.getSubscription.mockResolvedValue({ subscription });
  h.provider.getEntitlement.mockResolvedValue({
    namespace,
    billingMode: "service",
    status: "active",
    periodStart,
    periodEnd,
    computeCovered: false,
    serviceCovered: true,
  });
  expect(await paidEmailPlan(org)).toMatchObject({ plan: "team" });
  expect((await purchase()).status).toBe(409);
  h.provider.getSubscription.mockResolvedValue({
    subscription: { ...subscription, offer: { ...request.offer, unitAmount: 1 } },
  });
  await expect(paidEmailPlan(org)).rejects.toThrow("does not match");
  h.provider.getSubscription.mockResolvedValue({
    subscription: {
      ...subscription,
      metadata: { ...request.metadata, openship_organization: "other" },
    },
  });
  await expect(paidEmailPlan(org)).rejects.toThrow("does not match");
  h.provider.getSubscription.mockResolvedValue({
    subscription: { ...subscription, status: "canceled" },
  });
  h.provider.getEntitlement.mockRejectedValue(
    new Error("Expired mail no longer has a service entitlement"),
  );
  expect(await paidEmailPlan(org)).toBeNull();
});

it.each(["senders", "domains"] as const)(
  "reads and changes only this organization's %s caps",
  async (kind) => {
    const owner = await seedOwner(),
      other = await seedOwner();
    const namespace = sendingNamespace(owner.orgId);
    await repos.managedMail.ensureAccount(owner.orgId, namespace);
    await repos.managedMail.updateAccount(owner.orgId, { sendingEnabled: true });
    const collection = h.mail[kind];
    const identity = kind === "senders" ? "alex@example.test" : "example.test";
    const row = { identity, monthlyCap: 100, accepted: 17, pending: 2 };
    const meta = {
      monthStart: "2026-11-01T00:00:00Z",
      resetAt: "2026-12-01T00:00:00Z",
      unattributed: { accepted: 220, pending: 1 },
    };
    collection.listUsage
      .mockResolvedValueOnce({ ...meta, data: [], nextCursor: "page2" })
      .mockResolvedValueOnce({ ...meta, data: [row], nextCursor: null });
    const response = await call(owner, "/sending/usage/" + kind);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ canEdit: true, usage: { ...meta, data: [row] } });
    expect(collection.listUsage).toHaveBeenLastCalledWith(namespace, {
      limit: 100,
      cursor: "page2",
    });
    expect(await (await call(other, "/sending/usage/" + kind)).json()).toMatchObject({
      usage: null,
    });
    const update = (cap: number | null) =>
      call(
        owner,
        "/sending/caps/" + kind,
        { identity: identity.toUpperCase(), monthlyCap: cap },
        "PUT",
      );
    collection.setCap.mockResolvedValue({ success: true });
    collection.clearCap.mockResolvedValue({ success: true });
    expect((await update(-1)).status).toBe(400);
    expect((await update(0)).status).toBe(200);
    expect(collection.setCap).toHaveBeenCalledExactlyOnceWith(namespace, identity, 0);
    expect((await update(null)).status).toBe(200);
    expect(collection.clearCap).toHaveBeenCalledExactlyOnceWith(namespace, identity);
  },
);

it("submits a managed test from a ready domain in its paid namespace and reads its receipt", async () => {
  const owner = await seedOwner();
  const namespace = sendingNamespace(owner.orgId);
  const path = "/sending/domains/sender1/test-email";
  const input = { to: "person@example.test", idempotencyKey: "attempt-1234567890" };
  expect((await call(owner, path, input)).status).toBe(402);
  h.grants = JSON.stringify({ [owner.orgId]: { plan: "team", until: new Date(Date.now() + 60_000).toISOString() } });
  h.mail.tenants.ensure.mockResolvedValue({ namespace, holds: [] });
  h.mail.tenants.getPolicy.mockResolvedValue({ revision: 1 });
  h.mail.domains.get.mockResolvedValueOnce({ domain: "team.test", state: "verifying" });
  expect((await call(owner, path, input)).status).toBe(409);
  expect((await call(owner, path, { ...input, to: "one@example.test,two@example.test" })).status).toBe(400);
  expect(h.mail.messages.send).not.toHaveBeenCalled();
  h.mail.domains.get.mockResolvedValue({ id: "sender1", domain: "team.test", state: "ready" });
  const receipt = { id: "msg1", state: "queued", reason: null };
  h.mail.messages.send.mockResolvedValue({ ...receipt, credits: { amount: 1, state: "held" } });
  const result = await call(owner, path, input);
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ to: input.to, from: "openship@team.test", receipt });
  expect(h.mail.domains.get).toHaveBeenCalledWith(namespace, "sender1");
  expect(h.mail.messages.send).toHaveBeenCalledExactlyOnceWith(namespace,
    expect.objectContaining({ from: "openship@team.test", to: [input.to] }),
    { idempotencyKey: "openship-test-" + input.idempotencyKey });
  h.mail.messages.get.mockResolvedValue({ ...receipt, state: "delivered" });
  expect(await (await call(owner, "/sending/messages/msg1")).json()).toEqual({ ...receipt, state: "delivered" });
  expect(h.mail.messages.get).toHaveBeenCalledExactlyOnceWith(namespace, "msg1");
});

it("issues a private SMTP credential to a linked Cloud session and reuses it across verified domains", async () => {
  const owner = await seedOwner();
  const token = crypto.randomUUID();
  await db.insert(schema.session).values({
    id: crypto.randomUUID(), token, userId: owner.userId, activeOrganizationId: owner.orgId,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const linked = { ...owner, auth: { Authorization: "Bearer " + token } };
  const namespace = sendingNamespace(owner.orgId);
  const installation = "a".repeat(64);
  const name = "OpenShip SMTP · " + installation;
  const path = "/sending/domains/sender/smtp-key";
  h.grants = JSON.stringify({ [owner.orgId]: { plan: "team", until: new Date(Date.now() + 60_000).toISOString() } });
  h.mail.tenants.ensure.mockResolvedValue({ namespace, holds: [] });
  h.mail.tenants.getPolicy.mockResolvedValue({ revision: 1 });
  h.mail.domains.get.mockResolvedValue({ id: "sender", domain: "example.test", state: "ready" });
  h.mail.keys.list.mockResolvedValue({ data: [], nextCursor: null });
  h.mail.keys.create.mockResolvedValue({ id: "cred", secret: "fixture" });
  expect((await call(owner, path, { installation })).status).toBe(403);
  h.mail.domains.get.mockResolvedValueOnce({ id: "sender", state: "pending" });
  expect((await call(linked, path, { installation })).status).toBe(409);
  const issued = await call(linked, path, { installation });
  expect(issued.headers.get("cache-control")).toBe("no-store");
  expect(await issued.json()).toEqual({ namespace, id: "cred", secret: "fixture" });
  expect(h.mail.keys.create).toHaveBeenCalledExactlyOnceWith(namespace, { name });
  h.mail.domains.get.mockResolvedValue({ id: "other", domain: "other.test", state: "ready" });
  const saved = { id: "cred", domainId: null, name };
  h.mail.keys.list.mockResolvedValue({ data: [saved, { ...saved, id: "unrelated", name: "Hosted SMTP" }], nextCursor: null });
  const reused = await call(linked, "/sending/domains/other/smtp-key", { installation, installedId: "cred" });
  expect(await reused.json()).toEqual({ namespace, id: "cred" });
  expect(h.mail.keys.create).toHaveBeenCalledTimes(1);
  expect(h.mail.keys.revoke).not.toHaveBeenCalled();
  expect((await call(linked, "/sending/keys/cred", undefined, "DELETE")).status).toBe(200);
  expect(h.mail.keys.revoke).toHaveBeenCalledExactlyOnceWith(namespace, "cred");
  h.cloud = false;
  expect((await call(linked, path, { installation })).status).toBe(404);
});

it("scopes an OpenShip application key to submission, its workspace and one verified domain", async () => {
  const owner = await seedOwner();
  const other = await seedOwner();
  const namespace = sendingNamespace(owner.orgId);
  h.grants = JSON.stringify({ [owner.orgId]: { plan: "team", until: new Date(Date.now() + 60000).toISOString() } });
  h.mail.tenants.ensure.mockResolvedValue({ namespace, holds: [] });
  h.mail.tenants.getPolicy.mockResolvedValue({ revision: 1 });
  const domain = { id: "sender1", domain: "team.test", state: "ready" };
  h.mail.domains.get.mockResolvedValue(domain);
  const receipt = { id: "msg1", state: "queued", reason: null };
  h.mail.messages.send.mockResolvedValue({ ...receipt, credits: { amount: 1 } });
  const path = "/sending/domains/sender1/key";
  const issued = await (await call(owner, path, {})).json();
  expect(issued.key).toMatch(/^opsh_pat_[A-Za-z0-9_-]{43}$/);
  expect(await repos.patGrant.listByToken(issued.id)).toEqual([
    expect.objectContaining({ resourceType: "mail_sender", resourceId: domain.id, permissions: ["write"] }),
  ]);
  const auth = { Authorization: "Bearer " + issued.key };
  const input = { from: "hello@team.test", to: ["client@example.test"], subject: "Welcome", text: "Hello", idempotencyKey: "welcome-01" };
  function submit(body: object, headers = auth) {
    return app.request("/api/mail/send", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  }
  expect((await call(owner, "/send", input)).status).toBe(401);
  expect((await call({ ...owner, auth }, "/sending/keys")).status).toBe(401);
  expect((await call({ ...owner, auth }, path, {})).status).toBe(401);
  expect((await call({ ...other, auth }, "/send", input)).status).toBe(403);
  expect((await call(other, "/sending/keys/" + issued.id, undefined, "DELETE")).status).toBe(404);
  expect((await submit({ ...input, from: "hello@sub.team.test" })).status).toBe(403);
  expect((await submit({ ...input, namespace: "external" })).status).toBe(400);
  expect((await submit({ ...input, text: undefined })).status).toBe(400);
  expect((await submit({ ...input, bcc: Array(50).fill(input.to[0]) })).status).toBe(400);
  expect((await submit({ ...input, to: [] })).status).toBe(400);
  expect((await submit({ ...input, subject: "Subject\n" })).status).toBe(400);
  h.cloud = false;
  expect((await submit(input)).status).toBe(401);
  h.cloud = true;
  h.mail.domains.get.mockResolvedValueOnce({ ...domain, state: "verifying" });
  expect((await submit(input)).status).toBe(409);
  h.mail.domains.get.mockResolvedValueOnce({ ...domain, state: "disabled" });
  expect((await submit(input)).status).toBe(409);
  expect(h.mail.messages.send).not.toHaveBeenCalled();
  const result = await submit(input);
  expect(result.status).toBe(202);
  expect(await result.json()).toEqual(receipt);
  const { idempotencyKey, ...message } = input;
  expect(h.mail.messages.send).toHaveBeenCalledExactlyOnceWith(namespace, message, { idempotencyKey: expect.stringMatching(/^openship-api-/) });
  const retryOptions = h.mail.messages.send.mock.calls[0]![2];
  const replacement = await (await call(owner, path, {})).json();
  expect((await submit(input, { Authorization: "Bearer " + replacement.key })).status).toBe(202);
  expect(h.mail.messages.send).toHaveBeenLastCalledWith(namespace, message, retryOptions);
  h.mail.messages.send.mockRejectedValueOnce(new OblienError("limit", 429, "mail_quota_exhausted"));
  expect((await submit({ ...input, idempotencyKey: idempotencyKey + "2" })).status).toBe(429);
  expect((await call(owner, "/sending/keys/" + issued.id, undefined, "DELETE")).status).toBe(200);
  expect((await submit(input)).status).toBe(401);
  await db.update(schema.member).set({ role: "restricted" }).where(eq(schema.member.userId, owner.userId));
  expect((await submit(input, { Authorization: "Bearer " + replacement.key })).status).toBe(403);
  await db.update(schema.member).set({ role: "owner" }).where(eq(schema.member.userId, owner.userId));
  h.mail.domains.remove.mockResolvedValue({ released: true });
  expect((await call(owner, "/sending/domains/sender1", undefined, "DELETE")).status).toBe(200);
  expect((await submit(input, { Authorization: "Bearer " + replacement.key })).status).toBe(401);
});

it("honors existing email PATs only on submission and only with their stored grant", async () => {
  const owner = await seedOwner();
  const key = "opsh_send_existing_installation_fixture";
  const row = await repos.personalAccessToken.createWithGrants({
    userId: owner.userId, organizationId: owner.orgId, name: "Existing mail installation",
    tokenHash: hashPatToken(key), tokenPrefix: key.slice(0, 16), scoped: true, readOnly: false, expiresAt: null,
  }, [{ resourceType: "mail_sender", resourceId: "existing", permissions: ["write"] }]);
  const installation = { ...owner, auth: { Authorization: "Bearer " + key } };
  const message = { from: "hello@team.test", to: ["reader@example.test"], subject: "Hello", text: "Hi", idempotencyKey: "existing-01" };
  h.mail.domains.get.mockResolvedValue({ id: "existing", domain: "team.test", state: "ready" });
  h.mail.messages.send.mockResolvedValue({ id: "msg", state: "queued", reason: null });
  expect((await call(installation, "/sending/keys")).status).toBe(401);
  expect((await call(installation, "/send", message)).status).toBe(202);
  await repos.patGrant.createMany(row.id, [{ resourceType: "billing", resourceId: "*", permissions: ["admin"] }]);
  expect((await call(installation, "/send", message)).status).toBe(403);
  await repos.patGrant.deleteByToken(row.id);
  expect((await call(installation, "/send", message)).status).toBe(401);
  expect((await call(installation, "/sending/keys")).status).toBe(401);
  expect(h.mail.messages.send).toHaveBeenCalledTimes(1);
});

it("enables sending on the first cap only with an active grant and denies read-only writes", async () => {
  const owner = await seedOwner();
  const namespace = sendingNamespace(owner.orgId);
  const path = "/sending/caps/senders";
  const identity = "hello@example.test";
  const write = (monthlyCap: number | null) => call(owner, path, { identity, monthlyCap }, "PUT");
  expect((await write(null)).status).toBe(200);
  expect((await write(10)).status).toBe(402);
  expect(h.mail.tenants.ensure).not.toHaveBeenCalled();

  h.grants = JSON.stringify({
    [owner.orgId]: { plan: "team", until: new Date(Date.now() + 60_000).toISOString() },
  });
  h.mail.tenants.ensure.mockResolvedValue({ namespace, holds: [] });
  h.mail.tenants.getPolicy.mockResolvedValue({ revision: 2 });
  h.mail.senders.setCap.mockResolvedValue({ success: true });
  expect((await write(10)).status).toBe(200);
  expect(h.mail.senders.setCap).toHaveBeenCalledExactlyOnceWith(namespace, identity, 10);
  expect((await repos.managedMail.account(owner.orgId))?.sendingEnabled).toBe(true);

  h.mail.senders.setCap.mockRejectedValueOnce(new OblienError("Unknown identity", 404, "mail_not_found"));
  const missingIdentity = await write(10);
  expect(missingIdentity.status).toBe(409);
  expect(await missingIdentity.json()).toMatchObject({ code: "MAIL_SENDING_IDENTITY_MISSING" });

  await db
    .update(schema.personalAccessToken)
    .set({ readOnly: true })
    .where(eq(schema.personalAccessToken.userId, owner.userId));
  h.mail.senders.listUsage.mockResolvedValue({ data: [], nextCursor: null });
  expect(await (await call(owner, "/sending/usage/senders")).json()).toMatchObject({
    canEdit: false,
  });
  expect((await write(null)).status).toBe(403);
  expect(h.mail.senders.clearCap).not.toHaveBeenCalled();
});

it("lists every page of the organization's sending domains", async () => {
  const owner = await seedOwner();
  const namespace = sendingNamespace(owner.orgId);
  h.mail.domains.list
    .mockResolvedValueOnce({ data: [{ id: "first" }], nextCursor: "next" })
    .mockResolvedValueOnce({ data: [{ id: "last" }], nextCursor: null });
  const response = await call(owner, "/sending/domains");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    data: [{ id: "first" }, { id: "last" }],
    nextCursor: null,
  });
  expect(h.mail.domains.list).toHaveBeenLastCalledWith(namespace, { limit: 100, cursor: "next" });
});

it("routes two Cloud organizations to one shared worker with different sending and mailbox scopes", async () => {
  const owners = await Promise.all([seedOwner(), seedOwner()]);
  const grant = { plan: "team", until: new Date(Date.now() + 60000).toISOString() };
  h.grants = JSON.stringify(Object.fromEntries(owners.map((o) => [o.orgId, grant])));
  const engine = {
    serverId: "shared",
    origin: "https://worker.pool.test",
    token: "worker",
    hostname: "mail.pool.test",
    webmailUrl: "https://webmail.pool.test",
    placement: "standard",
    shared: true,
  };
  h.engines = JSON.stringify([engine]);
  const tenants = owners.map((o) => sendingNamespace(o.orgId));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname.endsWith("/status"))
        return Response.json({
          serverId: "shared",
          domain: "pool.test",
          finishedAt: 1,
          engine: { running: true, flavor: "container" },
          webmail: { installed: true, projectId: "mail", url: engine.webmailUrl },
        });
      if (url.pathname.endsWith("/webmail/hosting")) {
        expect(JSON.parse(String(init.body))).toEqual({ shared: true, imapHost: engine.hostname });
        return Response.json({ bound: true, apiRelay: true });
      }
      if (url.pathname.endsWith("/tenant-access")) {
        const { namespace, serviceId } = JSON.parse(String(init.body));
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer worker");
        expect(tenants).toContain(namespace);
        return Response.json({ token: "opsh_mail_" + serviceId });
      }
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBe("Bearer opsh_mail_" + headers.get("x-openship-mail-service"));
      const i = tenants.indexOf(url.pathname.split("/")[4]!);
      expect(i).toBeGreaterThanOrEqual(0);
      const root = `/api/mail/tenants/${tenants[i]}/admin/shared`;
      if (url.pathname === root + `/mailboxes/sam%40tenant-${i}.test`) {
        if (init.method === "PATCH") {
          expect(JSON.parse(String(init.body))).toEqual({ password: "replacement-password" });
          return Response.json({ mailbox: { username: `sam@tenant-${i}.test` } });
        }
        expect(init.method).toBe("DELETE");
        return Response.json({ ok: true, mode: url.searchParams.get("hard") === "true" ? "hard" : "soft" });
      }
      expect(url.pathname).toBe(root + "/domains");
      return Response.json({ domains: [{ domain: `tenant-${i}.test` }] });
    }),
  );
  const results = await Promise.all(
    owners.map((o) => call(o, "/managed", { placement: "standard" })),
  );
  expect(results.map((r) => r.status)).toEqual([200, 200]);
  const services = await Promise.all(results.map((r) => r.json()));
  expect(services[0].id).not.toBe(services[1].id);
  for (const [i, owner] of owners.entries()) {
    expect(await (await call(owner, "/admin/" + services[i].id + "/domains")).json()).toEqual({
      domains: [{ domain: `tenant-${i}.test` }],
    });
    expect([403, 404]).toContain(
      (await call(owner, "/admin/" + services[1 - i].id + "/domains")).status,
    );
    const path = `/admin/${services[i].id}/mailboxes/sam%40tenant-${i}.test`;
    const password = await call(owner, path, { password: "replacement-password" }, "PATCH");
    expect(password.status).toBe(200);
    expect(await password.json()).toEqual({ mailbox: { username: `sam@tenant-${i}.test` } });
    expect(await (await call(owner, path, undefined, "DELETE")).json()).toMatchObject({ mode: "soft" });
    expect(await (await call(owner, path + "?hard=true", undefined, "DELETE")).json()).toMatchObject({ mode: "hard" });
    expect([403, 404]).toContain((await call(owners[1 - i]!, path, undefined, "DELETE")).status);
  }
});

it("rejects a new install on an existing VM and preserves previously reserved VM installations", async () => {
  const owner = await seedOwner(),
    other = await seedOwner();
  const org = owner.orgId;
  const workspace = await repos.cloudWorkspace.create({ organizationId: org, name: "Mail VM" });
  const server = (await repos.server.findByWorkspace(workspace.id, org))!;
  const grant = { plan: "solo", until: new Date(Date.now() + 60_000).toISOString() };
  h.grants = JSON.stringify({ [org]: grant, [other.orgId]: grant });
  const input = { placement: "dedicated", cloudServerId: server.id };
  const worker = {
    serverId: "worker-mail",
    origin: "https://dedicated.worker.test",
    token: "test-worker",
    hostname: "mail.private.example",
    placement: "dedicated",
    webmailUrl: "https://webmail.private.example",
    cloudServerId: server.id,
    prepare: true,
  };
  let waitingForDns = false;
  let installed = false;
  let observation: { active?: boolean; observationError?: string } = { active: true };
  const fetch = vi.fn(async (url: URL, init: RequestInit) => {
    if (url.pathname.endsWith("/status"))
      return Response.json(
        installed
          ? {
              ...observation,
              serverId: worker.serverId,
              domain: "private.example",
              finishedAt: 1,
              engine: { running: true, flavor: "container" },
              webmail: { installed: true, projectId: "webmail", url: worker.webmailUrl, serverId: worker.serverId },
            }
          : {
              serverId: worker.serverId,
              active: false,
              ...(waitingForDns && { domain: "private.example", dnsRecords: {}, resumeStep: 7 }),
            },
      );
    if (url.pathname.endsWith("/dns-scan"))
      return Response.json({
        checks: [
          { key: "mx", status: "pass" },
          { key: "dkim", status: "pass" },
          { key: "ptr", status: "fail" },
        ],
      });
    if (url.pathname.endsWith("/dns-ack")) return Response.json({ ok: true });
    if (url.pathname.endsWith("/scan"))
      return Response.json({ iredmailInstalled: false, hasState: false });
    if (url.pathname.endsWith("/setup")) {
      expect(JSON.parse(String(init.body))).toMatchObject({
        serverId: worker.serverId,
        config: { compose: true },
        outboundDelivery: "relay",
        startStep: waitingForDns ? 7 : 1,
      });
      installed = waitingForDns;
      waitingForDns = true;
      return new Response("data: done\n\n", { headers: { "Content-Type": "text/event-stream" } });
    }
    if (url.pathname.endsWith("/domains"))
      return Response.json({ domains: [{ domain: "private.example" }] });
    if (url.pathname.endsWith("/webmail/hosting")) {
      expect(JSON.parse(String(init.body))).toEqual({
        namespace: sendingNamespace(org),
        dedicated: true,
        imapHost: worker.hostname,
      });
      return Response.json({ bound: true, apiRelay: true });
    }
    if (url.pathname.endsWith("/relay")) return Response.json({});
    throw new Error("Unexpected worker operation");
  });
  vi.stubGlobal("fetch", fetch);
  const { warmMailFleet } = await import("@repo/platform/engine/modules/managed-mail/fleet");
  h.engines = JSON.stringify([worker]);
  await warmMailFleet();
  expect(fetch).not.toHaveBeenCalled();
  expect([403, 404]).toContain((await call(other, "/managed", input)).status);
  h.engines = "[]";
  expect((await call(owner, "/managed", input)).status).toBe(409);
  await db.insert(schema.managedMailService).values({
    id: "managed-mail-legacy-first",
    organizationId: org,
    cloudServerId: server.id,
    placement: "dedicated",
    provisioning: true,
  });
  const request = await call(owner, "/managed", input);
  expect(request.status).toBe(200);
  const first = await request.json();
  const cancel = (actor: Owner, id: string) =>
    app.request("/api/mail/managed/" + id + "/reservation", {
      method: "DELETE",
      headers: { ...actor.auth, "X-Organization-Id": actor.orgId },
    });
  expect((await cancel(other, first.id)).status).toBe(404);
  expect((await cancel(owner, first.id)).status).toBe(200);
  await db.insert(schema.managedMailService).values({
    id: "managed-mail-legacy-second",
    organizationId: org,
    cloudServerId: server.id,
    placement: "dedicated",
    provisioning: true,
  });
  const pending = await (await call(owner, "/managed", input)).json();
  expect(pending).toMatchObject({ cloudServerId: server.id, provisioning: "network" });
  expect(await (await call(owner, "/managed", input)).json()).toEqual(pending);
  expect((await call(owner, "/managed", { placement: "dedicated" })).status).toBe(409);
  expect((await call(owner, "/admin/" + pending.id + "/domains")).status).toBe(409);
  await warmMailFleet();
  expect(fetch).not.toHaveBeenCalled();
  h.engines = JSON.stringify([worker]);
  await warmMailFleet();
  await warmMailFleet();
  expect(fetch.mock.calls.some(([url]) => url.pathname.endsWith("/dns-ack"))).toBe(true);
  expect(fetch.mock.calls.some(([url]) => url.pathname.endsWith("/ptr-ack"))).toBe(false);
  observation = { observationError: "worker unavailable" };
  await warmMailFleet();
  expect(fetch.mock.calls.some(([url]) => url.pathname.endsWith("/webmail/hosting"))).toBe(false);
  expect((await (await call(owner, "/managed")).json()).service.provisioning).toBe("install");
  observation = { active: false };
  await warmMailFleet();
  const { service } = await (await call(owner, "/managed")).json();
  expect(service).toMatchObject({
    id: pending.id,
    cloudServerId: server.id,
    hostname: worker.hostname,
  });
  expect(service.provisioning).toBeUndefined();
  const count = fetch.mock.calls.length;
  await warmMailFleet();
  expect(fetch).toHaveBeenCalledTimes(count);
  expect((await cancel(owner, pending.id)).status).toBe(409);
  expect(h.provider.createCheckout).not.toHaveBeenCalled();
  await db
    .update(schema.cloudWorkspace)
    .set({ deletionInProgress: new Date() })
    .where(eq(schema.cloudWorkspace.id, workspace.id));
  expect((await call(owner, "/managed")).status).toBe(409);
  expect((await call(owner, "/admin/" + pending.id + "/domains")).status).toBe(409);
  expect(fetch).toHaveBeenCalledTimes(count);
});

it("keeps sending checkout open while closing new hosted orders and activation", async () => {
  const owner = await seedOwner();
  h.hostedEnrollmentEnabled = false;
  expect(await (await call(owner, "/managed")).json()).toMatchObject({
    hostedEnrollmentEnabled: false, checkoutEnabled: true, hostingAvailable: false,
  });
  const checkout = (body: object) => call(owner, "/managed/checkout", body);
  expect((await checkout({ plan: "team" })).status).toBe(503);
  expect((await checkout({
    product: "dedicated", plan: "team", storageGB: 200, purchaseId: crypto.randomUUID(),
    expectedMonthlyCents: 3400,
  })).status).toBe(503);
  expect((await call(owner, "/managed", { placement: "standard" })).status).toBe(503);
  expect(h.provider.createCheckout).not.toHaveBeenCalled();
  expect(await repos.managedMail.orders(owner.orgId)).toHaveLength(0);
  h.provider.createCheckout.mockResolvedValue({ checkoutId: "sending", url: "https://checkout.example.test" });
  expect((await checkout({ plan: "team", product: "sending" })).status).toBe(200);
  expect(h.provider.createCheckout).toHaveBeenCalledTimes(1);
});

it("reports disabled checkout before any provider payment request", async () => {
  const owner = await seedOwner();
  h.billingEnabled = false;
  expect(await (await call(owner, "/managed")).json()).toMatchObject({ checkoutEnabled: false });
  expect(
    (await call(owner, "/managed/checkout", { product: "sending", plan: "solo" })).status,
  ).toBe(503);
  expect(h.provider.createCheckout).not.toHaveBeenCalled();
  expect(h.prepare).not.toHaveBeenCalled();
});

it("sells the sender API at its own price, enforces its quota, and preserves compute inboxes", async () => {
  const owner = await seedOwner();
  const namespace = sendingNamespace(owner.orgId);
  const purchase = (product: string) =>
    call(owner, "/managed/checkout", { plan: "scale", product });
  h.provider.createCheckout.mockResolvedValue({
    checkoutId: "api-scale",
    url: "https://checkout.example.test/api",
  });
  h.provider.getCheckout.mockResolvedValue({ checkout: { status: "open" } });
  expect((await purchase("sending")).status).toBe(200);
  const request = h.provider.createCheckout.mock.calls[0][0];
  expect(request).toMatchObject({
    namespace,
    offer: { reference: "openship:mail:v1:sending:scale", unitAmount: 4000 },
    metadata: { openship_mail_product: "sending", openship_mail_plan: "scale" },
  });
  expect((await purchase("mailboxes")).status).toBe(409);
  expect(await (await call(owner, "/managed")).json()).toMatchObject({
    pendingPlan: "scale",
    pendingProduct: "sending",
  });
  expect((await purchase("sending")).status).toBe(200);
  expect(h.provider.createCheckout.mock.lastCall?.[0].idempotencyKey).toBe(request.idempotencyKey);

  const periodStart = new Date(Date.now() - 10_000).toISOString();
  const periodEnd = new Date(Date.now() + 86_400_000).toISOString();
  const subscription = { ...request, status: "active", periodStart, periodEnd };
  h.provider.getSubscription.mockResolvedValue({ subscription });
  h.provider.getEntitlement.mockImplementation(async (ns: string) => ({
    namespace: ns,
    billingMode: ns === namespace ? "service" : "monthly",
    tierId: "reseller",
    status: "active",
    periodStart,
    periodEnd,
    computeCovered: ns !== namespace,
    serviceCovered: ns === namespace,
  }));
  const active = await (await call(owner, "/managed")).json();
  expect(active).toMatchObject({
    product: "sending",
    mailboxPlan: null,
    plan: "scale",
    limits: { recipients: 200000, mailboxes: 0 },
  });
  expect(active.pendingPlan).toBeUndefined();
  expect((await call(owner, "/managed", { placement: "standard" })).status).toBe(402);
  h.mail.tenants.ensure.mockResolvedValue({ namespace, holds: [] });
  h.mail.tenants.getPolicy.mockResolvedValue({ revision: 4 });
  h.mail.domains.get.mockResolvedValue({ id: "sender", state: "ready", domain: "example.test" });
  const issued = await (await call(owner, "/sending/domains/sender/key", {})).json();
  expect(issued).toEqual({ id: expect.stringMatching(/^pat_/), key: expect.stringMatching(/^opsh_pat_/) });
  expect(h.mail.keys.create).not.toHaveBeenCalled();
  const legacy = { id: "key", name: "Openship Mail · example.test", prefix: "test", domainId: "sender", createdAt: "2026-11-25T12:00:00Z", lastUsedAt: null };
  h.mail.keys.list.mockResolvedValue({ data: [legacy, { ...legacy, id: "worker", name: "Hosted webmail · example.test" }], nextCursor: null });
  expect(await (await call(owner, "/sending/keys")).json()).toEqual({ data: [
    { id: issued.id, name: "OpenShip Mail · example.test", prefix: issued.key.slice(0, PAT_PREFIX.length + 6), domainId: "sender", createdAt: expect.any(String), lastUsedAt: null },
    { ...legacy, legacy: true },
  ] });
  expect((await call(owner, "/sending/keys/worker", undefined, "DELETE")).status).toBe(404);
  expect(h.mail.keys.revoke).not.toHaveBeenCalled();
  expect((await call(owner, "/sending/keys/key", undefined, "DELETE")).status).toBe(200);
  expect(h.mail.keys.revoke).toHaveBeenCalledExactlyOnceWith(namespace, "key");
  expect(h.mail.keys.list).toHaveBeenCalledWith(namespace, expect.objectContaining({ limit: 100 }));
  expect(h.mail.tenants.updatePolicy).toHaveBeenCalledWith(
    namespace,
    expect.objectContaining({ period: 200000, daily: 20000, domains: 1000 }),
  );
  await db
    .update(schema.organization)
    .set({ oblienNamespace: "compute-" + owner.orgId })
    .where(eq(schema.organization.id, owner.orgId));
  expect(await (await call(owner, "/managed")).json()).toMatchObject({
    product: "sending",
    plan: "scale",
    mailboxPlan: "included",
    limits: { mailboxes: 1, recipients: 200000 },
  });
  h.provider.getSubscription.mockResolvedValue({
    subscription: { ...subscription, status: "canceled" },
  });
  h.provider.getCheckout.mockResolvedValue({ checkout: { status: "complete", fulfilled: true } });
  const canceled = await (await call(owner, "/managed")).json();
  expect(canceled).toMatchObject({
    plan: "included",
    mailboxPlan: "included",
    hasBillingAccount: true,
  });
  expect(canceled.pendingPlan).toBeUndefined();
  h.provider.getSubscription.mockResolvedValue({
    subscription: {
      ...subscription,
      metadata: { ...request.metadata, openship_mail_product: "mailboxes" },
    },
  });
  await expect(paidEmailPlan(owner.orgId)).rejects.toThrow("does not match");
});

it("an API-only grant authorizes sending independently of hosted mailbox capacity", async () => {
  const owner = await seedOwner();
  h.grants = JSON.stringify({
    [owner.orgId]: {
      plan: "team",
      sendingOnly: true,
      until: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  const summary = await (await call(owner, "/managed")).json();
  expect(summary).toMatchObject({
    plan: "team",
    mailboxPlan: null,
    sendingConfigured: false,
    service: null,
    limits: { mailboxes: 0, storageMB: 0, recipients: 25000 },
  });
  expect((await call(owner, "/managed", { placement: "standard" })).status).toBe(402);
  const ns = sendingNamespace(owner.orgId);
  h.mail.tenants.ensure.mockResolvedValue({ namespace: "provider-namespace-id", holds: [] });
  h.namespaces.get.mockResolvedValue({ data: { slug: ns, id: "provider-namespace-id" } });
  h.mail.tenants.getPolicy.mockResolvedValue({ revision: 1 });
  h.mail.domains.list.mockResolvedValue({ data: [], nextCursor: null });
  h.mail.domains.add.mockResolvedValue({ id: "sender", domain: "customer.example" });
  expect((await call(owner, "/sending/domains", { domain: "customer.example" })).status).toBe(200);
  expect(await (await call(owner, "/managed")).json()).toMatchObject({ sendingConfigured: true });
  h.grants = "{}";
  expect(await (await call(owner, "/managed")).json()).toMatchObject({
    plan: null,
    sendingConfigured: true,
  });
  expect(h.mail.tenants.updatePolicy).toHaveBeenCalledWith(
    ns,
    expect.objectContaining({ period: 25000 }),
  );
});

it.each(["slug", "id"] as const)("rejects an inconsistent provider namespace %s before applying a mail policy", async (field) => {
  const owner = await seedOwner();
  const slug = sendingNamespace(owner.orgId);
  h.grants = JSON.stringify({ [owner.orgId]: { plan: "team", until: new Date(Date.now() + 60_000).toISOString() } });
  h.mail.tenants.ensure.mockResolvedValue({ namespace: "provider-namespace-id", holds: [] });
  h.namespaces.get.mockResolvedValue({ data: { slug, id: "provider-namespace-id", [field]: "other-namespace" } });
  expect((await call(owner, "/sending/domains", { domain: "customer.example" })).status).toBe(502);
  expect(h.namespaces.get).toHaveBeenCalledWith(slug);
  expect(h.mail.tenants.getPolicy).not.toHaveBeenCalled();
  expect(h.mail.domains.add).not.toHaveBeenCalled();
});

it("fulfills the reviewed dedicated order once, retains shared inboxes and pools sending", async () => {
  const owner = await seedOwner(),
    other = await seedOwner();
  const org = owner.orgId;
  const periodStart = new Date(Date.now() - 60000).toISOString();
  const periodEnd = new Date(Date.now() + 86400000).toISOString();
  h.grants = JSON.stringify({ [org]: { plan: "solo", until: periodEnd } });
  const shared = {
    serverId: "shared",
    origin: "https://shared.test",
    hostname: "mail.shared.test",
    shared: true,
    placement: "standard" as const,
    prepare: false,
    token: "test",
    webmailUrl: "https://webmail.shared.test",
  };
  const { engineIdentity } = await import("@repo/platform/engine/modules/managed-mail/service");
  await repos.managedMail.claim({
    organizationId: org,
    id: "managed-mail-shared-control",
    engine: engineIdentity(shared),
    hostname: shared.hostname,
    shared: true,
    placement: "standard",
  });
  h.engines = JSON.stringify([shared]);
  const purchase = {
    product: "dedicated",
    plan: "team",
    storageGB: 200,
    purchaseId: crypto.randomUUID(),
    expectedMonthlyCents: 3400,
  };
  h.provider.createCheckout.mockResolvedValue({
    checkoutId: "dedicated-session",
    url: "https://checkout.stripe.com/example",
  });
  h.provider.getCheckout.mockResolvedValue({ checkout: { status: "open" } });
  expect(
    (await call(owner, "/managed/checkout", { ...purchase, expectedMonthlyCents: 2900 })).status,
  ).toBe(409);
  expect(h.provider.createCheckout).not.toHaveBeenCalled();
  for (let i = 0; i < 2; i++)
    expect((await call(owner, "/managed/checkout", purchase)).status).toBe(200);
  const [row] = await repos.managedMail.orders(org);
  const checkout = h.provider.createCheckout.mock.calls[0]![0];
  expect(checkout).toMatchObject({
    namespace: row!.billingNamespace,
    idempotencyKey: row!.id,
    offer: {
      billingMode: "monthly",
      unitAmount: 3400,
      capacity: { diskGb: 225, workspaces: 1 },
      credits: 0,
    },
  });
  expect(await repos.managedMail.orders(org)).toHaveLength(1);
  expect(h.provider.createCheckout.mock.calls[1]![0].idempotencyKey).toBe(checkout.idempotencyKey);
  const selected = "/managed/services/" + row!.id;
  expect((await call(other, selected)).status).toBe(404);
  expect((await call(other, selected + "/cancel", {})).status).toBe(404);
  expect((await (await call(owner, selected)).json()).service.provisioning).toBe("payment");
  const { warmMailFleet } = await import("@repo/platform/engine/modules/managed-mail/fleet");
  await warmMailFleet();
  expect(h.vmCreate).not.toHaveBeenCalled();
  const subscription = {
    status: "active",
    billingInterval: "monthly",
    periodStart,
    periodEnd,
    ...checkout,
  };
  h.provider.getSubscription.mockResolvedValue({
    subscription: {
      ...subscription,
      metadata: { ...checkout.metadata, openship_organization: other.orgId },
    },
  });
  await warmMailFleet();
  expect(h.vmCreate).not.toHaveBeenCalled();
  h.provider.getSubscription.mockResolvedValue({ subscription });
  h.provider.getEntitlement.mockResolvedValue({
    namespace: row!.billingNamespace,
    tierId: "capacity",
    status: "active",
    billingMode: "monthly",
    computeCovered: true,
    periodStart,
    periodEnd,
    capacity: {
      namespace: row!.billingNamespace,
      provider: "stripe",
      billingMode: "monthly",
      computeCovered: true,
      periodStart,
      periodEnd,
      capacity: checkout.offer.capacity,
    },
  });
  const vm = { id: "vm-123", namespace: row!.billingNamespace, slug: row!.billingNamespace };
  h.vmCreate.mockResolvedValue(vm);
  h.vmRead.mockResolvedValue(vm);
  const readSsh = vi.fn(async () => ({
    ssh_enabled: true,
    connection: { user: "root", host: vm.id, bastion: "ssh.oblien.test" },
  }));
  const setKey = vi.fn();
  const expose = vi.fn(async () => ({ active: true, address: "2001:db8::123" }));
  h.vmHandle.mockReturnValue({
    network: {
      getPublicIPv6: async () => ({ supported: true, enabled: false, revision: 1 }),
      setPublicIPv6: expose,
    },
    ssh: { status: readSsh, setKey },
  });
  h.fleet = JSON.stringify({
    origin: "https://worker.test",
    token: "fixture",
    domain: "fleet.test",
    webmailIngressIPv4: "192.0.2.10",
    sshPublicKey: "ssh-ed25519 Zml4dHVyZQ==",
    dnsProvider: "cloudflare",
    dnsToken: "fixture",
    zoneId: "fixture",
  });
  let registered: object | undefined;
  let installed = false;
  let acknowledged = false;
  const domain = row!.id + ".fleet.test";
  const registeredId = "worker-new-mail";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname === "/api/system/servers") {
        if (!init.body) return Response.json(registered ? [registered] : []);
        const server = JSON.parse(String(init.body));
        expect(server).toMatchObject({
          name: row!.id,
          sshHost: vm.id,
          sshUser: "root",
          sshJumpHost: "root@ssh.oblien.test",
        });
        registered = { ...server, id: registeredId };
        return Response.json(registered);
      }
      if (url.pathname.endsWith("/status"))
        return Response.json({
          serverId: registeredId,
          domain,
          ...(acknowledged && { dnsAcknowledged: true }),
          ...(installed
            ? {
                finishedAt: 1,
                engine: { running: true, flavor: "container" },
                webmail: {
                  installed: true,
                  projectId: "webmail",
                  serverId: registeredId,
                  url: "https://webmail." + domain,
                },
              }
            : {
                dnsRecords: {
                  dkim: {
                    type: "TXT",
                    name: "dkim._domainkey." + domain,
                    value: "v=DKIM1; p=fixture",
                  },
                },
              }),
        });
      if (url.pathname.endsWith("/dns-scan"))
        return Response.json({ checks: ["dkim", "mx"].map((key) => ({ key, status: "pass" })) });
      if (url.pathname.endsWith("/dns-ack")) {
        acknowledged = true;
        return Response.json({ ok: true });
      }
      if (url.pathname.endsWith("/setup")) {
        expect(JSON.parse(String(init.body))).toMatchObject({
          serverId: registeredId,
          config: { compose: true },
          outboundDelivery: "relay",
        });
        installed = true;
        return new Response("data: done\n\n", { headers: { "Content-Type": "text/event-stream" } });
      }
      if (url.pathname.endsWith("/domains")) return Response.json({ domains: [{ domain }] });
      if (url.pathname.endsWith("/webmail/hosting")) {
        expect(JSON.parse(String(init.body))).toMatchObject({ namespace: sendingNamespace(owner.orgId), dedicated: true });
        return Response.json({ bound: true, apiRelay: true });
      }
      if (url.pathname.endsWith("/relay")) return Response.json({});
      throw new Error("Unexpected worker operation");
    }),
  );
  await warmMailFleet();
  await warmMailFleet();
  await warmMailFleet();
  expect(h.vmCreate).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      namespace: row!.billingNamespace,
      mode: "permanent",
      idempotency_key: row!.id,
      config: expect.objectContaining({ disk_size_mb: 225 * 1024 }),
    }),
  );
  expect(expose).toHaveBeenCalledExactlyOnceWith({
    enabled: true,
    expected_revision: 1,
    tcp_ports: [25, 80, 443, 587, 993],
  });
  expect(h.dnsWrite).toHaveBeenCalledWith(expect.anything(), "fixture", {
    type: "A", name: "webmail." + domain, content: "192.0.2.10", proxied: false,
  });
  expect(h.dnsWrite).not.toHaveBeenCalledWith(expect.anything(), "fixture",
    expect.objectContaining({ type: "A", name: "mail." + domain }));
  expect(h.dnsWrite).toHaveBeenCalledWith(
    expect.anything(),
    "fixture",
    expect.objectContaining({ type: "TXT", name: "dkim._domainkey." + domain }),
  );
  const dedicated = await (await call(owner, selected)).json();
  expect(dedicated).toMatchObject({
    plan: "team",
    product: "dedicated",
    service: { hostname: "mail." + domain, id: row!.id },
    limits: { storageMB: 200 * 1024, recipients: 30000, mailboxes: null },
  });
  const base = await (await call(owner, "/managed")).json();
  expect(base).toMatchObject({
    plan: "solo",
    service: { id: "managed-mail-shared-control" },
    limits: { recipients: 30000, mailboxes: 1 },
    sendingAllowance: 30000,
  });
  expect(base.services).toHaveLength(2);
  expect(await (await call(owner, "/managed/checkout", purchase)).json()).toEqual({
    url: checkout.successUrl,
  });
  h.provider.getSubscription.mockResolvedValue({
    subscription: { ...subscription, status: "canceled" },
  });
  expect(await (await call(owner, selected)).json()).toMatchObject({
    plan: null,
    service: { id: row!.id },
  });
  expect(await (await call(owner, "/managed")).json()).toMatchObject({
    limits: { recipients: 5000 },
  });
});

it("keeps a dedicated-only workspace's inbox reachable when billing is unavailable", async () => {
  const owner = await seedOwner();
  h.provider.createCheckout.mockResolvedValue({ checkoutId: "session", url: "https://checkout.example.test" });
  expect((await call(owner, "/managed/checkout", {
    product: "dedicated", plan: "solo", storageGB: 100, expectedMonthlyCents: 2500,
    purchaseId: crypto.randomUUID(),
  })).status).toBe(200);
  const [order] = await repos.managedMail.orders(owner.orgId);
  const engine = {
    placement: "dedicated" as const, serverId: "worker", origin: "https://worker.example.test",
    providerVmId: "vm-" + order!.id, hostname: "mail." + order!.id + ".test",
    webmailUrl: "https://webmail." + order!.id + ".test", token: "test", prepare: false,
  };
  h.engines = JSON.stringify([engine]);
  const { engineIdentity } = await import("@repo/platform/engine/modules/managed-mail/service");
  await repos.managedMail.updateOrder(owner.orgId, order!.id, { orderState: "funded", cloudServerId: engine.providerVmId });
  await repos.managedMail.attachVm(order!.id, owner.orgId, engineIdentity(engine), engine.hostname);
  await repos.managedMail.finishProvisioning(order!.id, owner.orgId);
  h.provider.getSubscription.mockRejectedValue(new Error("Billing unavailable"));

  expect(await (await call(owner, "/managed")).json()).toMatchObject({
    billingUnavailable: true, service: null, services: [{ id: order!.id, pendingCheckout: false }],
  });
  const selected = "/managed/services/" + order!.id;
  expect(await (await call(owner, selected)).json()).toMatchObject({
    billingUnavailable: true, service: { id: order!.id, webmailUrl: engine.webmailUrl },
  });
  expect((await call(await seedOwner(), selected)).status).toBe(404);
});

it("recovers an expired dedicated checkout and cancels only the selected pending order", async () => {
  const owner = await seedOwner();
  const buy = () =>
    call(owner, "/managed/checkout", {
      product: "dedicated",
      plan: "solo",
      storageGB: 100,
      expectedMonthlyCents: 2500,
      purchaseId: crypto.randomUUID(),
    });
  h.provider.createCheckout.mockResolvedValue({
    checkoutId: "first",
    url: "https://checkout.stripe.com/example",
  });
  expect((await buy()).status).toBe(200);
  const [first] = await repos.managedMail.orders(owner.orgId);
  h.provider.getCheckout.mockResolvedValue({ checkout: { status: "expired" } });
  h.provider.createCheckout.mockResolvedValue({
    checkoutId: "second",
    url: "https://checkout.stripe.com/example",
  });
  expect((await buy()).status).toBe(200);
  const [second] = await repos.managedMail.orders(owner.orgId);
  expect(second!.id).not.toBe(first!.id);
  h.provider.getCheckout.mockResolvedValue({ checkout: { status: "open" } });
  h.provider.cancelCheckout.mockResolvedValue({ checkout: { status: "expired" } });
  expect((await call(owner, "/managed/services/" + second!.id + "/cancel", {})).status).toBe(200);
  expect(await repos.managedMail.orders(owner.orgId)).toHaveLength(0);
  expect(h.vmCreate).not.toHaveBeenCalled();
});

it.each([["mailboxes", "mailboxes"], ["sending", "sending"], ["sending", "mailboxes"], ["dedicated", "dedicated"]] as const)(
  "changes the existing %s subscription to %s through a recoverable provider quote",
  async (product, nextProduct) => {
    const owner = await seedOwner(),
      outsider = await seedOwner();
    const org = owner.orgId;
    const periodStart = new Date(Date.now() - 86_400_000).toISOString();
    const periodEnd = new Date(Date.now() + 86_400_000).toISOString();
    h.provider.createCheckout.mockResolvedValue({
      checkoutId: "checkout",
      url: "https://checkout.stripe.com/test",
    });
    const initial = {
      product,
      plan: "solo",
      ...(product === "dedicated" && {
        storageGB: 100,
        expectedMonthlyCents: 2500,
        purchaseId: crypto.randomUUID(),
      }),
    };
    expect((await call(owner, "/managed/checkout", initial)).status).toBe(200);
    const checkout = h.provider.createCheckout.mock.calls[0]![0];
    const namespace = checkout.namespace;
    const oldOffer = checkout.offer;
    let subscription = {
      ...checkout,
      tierId: "reseller",
      status: "active",
      periodStart,
      periodEnd,
    };
    h.provider.getSubscription.mockImplementation(async () => ({ subscription }));
    h.provider.getEntitlement.mockImplementation(async () => ({
      namespace,
      status: "active",
      periodStart,
      periodEnd,
      tierId: product === "dedicated" ? "capacity" : "reseller",
      serviceCovered: product !== "dedicated",
      computeCovered: product === "dedicated",
      billingMode: subscription.offer.billingMode,
      capacity:
        product === "dedicated"
          ? {
              namespace,
              provider: "stripe",
              billingMode: "monthly",
              periodStart,
              periodEnd,
              computeCovered: true,
              capacity: subscription.offer.capacity,
            }
          : undefined,
    }));
    const [row] = await repos.managedMail.orders(org);
    const target = row?.id ?? "account";
    if (row) {
      await repos.managedMail.updateOrder(org, row.id, {
        orderState: "funded",
        cloudServerId: "vm-1",
      });
      await repos.managedMail.attachVm(row.id, org, "worker-id", "mail.example.test");
      await repos.managedMail.finishProvisioning(row.id, org);
      h.vmRead.mockResolvedValue({
        id: "vm-1",
        namespace,
        slug: namespace,
        resources: {
          cpus: row.order!.cpuCores,
          memory_mb: row.order!.memoryMB,
          disk_size_mb: row.order!.diskGB * 1024,
        },
      });
    }
    const path = "/managed/plans/" + target + "/change";
    const selected = {
      plan: "team",
      idempotencyKey: crypto.randomUUID(),
      ...(product !== nextProduct && { product: nextProduct }),
      ...(row && { storageGB: 200 }),
    };
    if (row) {
      h.engines = JSON.stringify([
        {
          providerVmId: "vm-1",
          serverId: "worker-id",
          placement: "dedicated",
          origin: "https://worker.test",
          hostname: "mail.example.test",
          webmailUrl: "https://webmail.example.test",
          token: "fixture",
          mailboxStorageMB: 100 * 1024,
        },
      ]);
      expect((await call(owner, path + "/preview", selected)).status).toBe(409);
      expect(h.provider.previewPlanChange).not.toHaveBeenCalled();
      h.engines = "[]";
    }
    h.provider.previewPlanChange.mockImplementation(async (_, request) => ({
      quote: {
        id: "quote",
        namespace,
        current: oldOffer,
        next: request.offer,
        direction: "upgrade",
        expiresAt: periodEnd,
        effectiveAt: periodStart,
        currency: "usd",
        unusedTimeCredit: 100,
        remainingTimeCharge: 200,
        amountDueNow: 100,
        nextInvoiceAmount: request.offer.unitAmount,
      },
    }));
    expect((await call(outsider, path + "/preview", selected)).status).toBe(404);
    if (product !== nextProduct) {
      h.hostedEnrollmentEnabled = false;
      expect((await call(owner, path + "/preview", selected)).status).toBe(503);
      expect(h.provider.previewPlanChange).not.toHaveBeenCalled();
      h.hostedEnrollmentEnabled = true;
    }
    const response = await call(owner, path + "/preview", selected);
    expect(response.status).toBe(200);
    const quote = await response.json();
    expect(quote).toMatchObject({
      id: "quote",
      amountDueNow: 100,
      allowances: { current: { recipients: 5000 }, next: { recipients: 25000 } },
      ...(row ? { resize: { after: { diskMb: 225 * 1024 } } } : { resize: null }),
    });
    const { offer, metadata } = h.provider.previewPlanChange.mock.calls[0]![1];
    if (product !== nextProduct) {
      h.hostedEnrollmentEnabled = false;
      expect((await call(owner, path, { quoteId: "quote", confirmRestart: true })).status).toBe(503);
      expect(h.provider.changePlan).not.toHaveBeenCalled();
      h.hostedEnrollmentEnabled = true;
      expect(metadata.openship_mail_product).toBe("mailboxes");
      expect(quote.allowances.current.mailboxes).toBeUndefined();
      expect(quote.allowances.next).toMatchObject({ mailboxes: 5, storageGB: 25 });
      expect(await paidEmailPlan(org)).toMatchObject({ sendingOnly: true });
    }
    let change = {
      id: "change",
      quoteId: "quote",
      namespace,
      current: oldOffer,
      next: offer,
      status: "payment_pending",
      direction: "upgrade",
      effectiveAt: periodStart,
      amountDueNow: 100,
      currency: "usd",
      cancelable: true,
      appliedAt: null,
    };
    h.provider.changePlan
      .mockRejectedValueOnce(new Error("response lost"))
      .mockImplementation(async () => ({ change }));
    h.provider.getPlanChange.mockImplementation(async () => ({ change }));
    expect(
      (await call(owner, path, { quoteId: "someone_elses_quote", confirmRestart: true })).status,
    ).toBe(409);
    expect((await call(owner, path, { quoteId: "quote", confirmRestart: true })).status).toBe(500);
    const { reconcileMailChange } =
      await import("@repo/platform/engine/modules/managed-mail/plan-change");
    await reconcileMailChange(org, target);
    expect(h.provider.changePlan.mock.calls[0]).toEqual(h.provider.changePlan.mock.calls[1]);
    expect((await (await call(owner, path)).json()).change.status).toBe("payment_pending");
    expect(h.resize).not.toHaveBeenCalled();
    expect((await call(owner, path + "/preview", selected)).status).toBe(409);
    change = { ...change, status: "applied" };
    subscription = { ...subscription, offer, metadata };
    if (row) {
      const policy = {
        id: "namespace-id",
        slug: namespace,
        resource_limits: checkout.offer.resourceLimits,
      };
      h.namespaces.get.mockImplementation(async () => ({ data: policy }));
      h.namespaces.update.mockImplementation(async (_, { resource_limits }) => {
        policy.resource_limits = resource_limits;
        return { data: policy };
      });
      h.resize.mockImplementationOnce(async ({ restartCheckpoint }) => {
        await restartCheckpoint.save({
          wasRunning: true,
          containers: ["a".repeat(64)],
          processes: [],
        });
        throw new Error("restore interrupted");
      });
      await expect(reconcileMailChange(org, target)).rejects.toThrow("restore interrupted");
      expect((await repos.managedMail.service(org, target))?.order?.storageGB).toBe(100);
      h.resize.mockClear();
    } else {
      await repos.managedMail.updateAccount(org, { sendingEnabled: true });
      h.mail.tenants.ensure.mockResolvedValue({ namespace, holds: [] });
      h.mail.tenants.getPolicy.mockResolvedValue({ revision: 41 });
    }
    await reconcileMailChange(org, target);
    await reconcileMailChange(org, target);
    expect(await (await call(owner, path + "/change")).json()).toMatchObject({
      pending: false,
      change: { status: "applied" },
    });
    if (row) {
      expect((await call(owner, "/managed/checkout", initial)).status).toBe(200);
      expect(h.namespaces.update).toHaveBeenCalledExactlyOnceWith("namespace-id", {
        resource_limits: expect.objectContaining({ max_disk_gb: 225, max_total_disk_gb: 225 }),
      });
      expect(h.resize).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          workspaceId: "vm-1",
          namespace,
          restartCheckpoint: expect.objectContaining({
            workloads: { wasRunning: true, containers: ["a".repeat(64)], processes: [] },
          }),
          resources: expect.objectContaining({ diskMb: 225 * 1024 }),
        }),
      );
      expect(await repos.managedMail.service(org, target)).toMatchObject({
        cloudServerId: "vm-1",
        order: { plan: "team", storageGB: 200 },
      });
      expect((await call(owner, path + "/preview", { ...selected, storageGB: 100 })).status).toBe(
        409,
      );
    } else {
      expect(await paidEmailPlan(org)).toMatchObject({
        plan: "team",
        sendingOnly: nextProduct === "sending",
      });
      expect(h.mail.tenants.updatePolicy).toHaveBeenCalledExactlyOnceWith(
        namespace,
        expect.objectContaining({ period: 25000, revision: 41 }),
      );
      expect(h.mail.keys.revoke).not.toHaveBeenCalled();
      h.provider.previewPlanChange.mockImplementationOnce(async (_, request) => ({
        quote: {
          id: "downgrade",
          namespace,
          current: offer,
          next: request.offer,
          direction: "downgrade",
          effectiveAt: periodEnd,
          expiresAt: periodEnd,
          amountDueNow: 0,
          unusedTimeCredit: 0,
          remainingTimeCharge: 0,
          nextInvoiceAmount: request.offer.unitAmount,
          currency: "usd",
        },
      }));
      expect(
        (
          await call(owner, path + "/preview", {
            plan: "solo",
            idempotencyKey: crypto.randomUUID(),
          })
        ).status,
      ).toBe(200);
      const downgrade = {
        ...change,
        id: "scheduled",
        quoteId: "downgrade",
        status: "scheduled",
        direction: "downgrade",
        current: offer,
        next: h.provider.previewPlanChange.mock.calls.at(-1)![1].offer,
      };
      h.provider.changePlan.mockResolvedValueOnce({ change: downgrade });
      h.provider.getPlanChange.mockResolvedValue({ change: downgrade });
      expect(
        await (await call(owner, path, { quoteId: "downgrade", confirmRestart: true })).json(),
      ).toMatchObject({ status: "scheduled" });
      await reconcileMailChange(org, target);
      expect((await paidEmailPlan(org))?.plan).toBe("team");
      h.provider.cancelPlanChange.mockResolvedValue({
        change: { ...downgrade, status: "canceled" },
      });
      expect((await call(owner, path + "/cancel", { changeId: "wrong" })).status).toBe(404);
      expect(
        await (await call(owner, path + "/cancel", { changeId: "scheduled" })).json(),
      ).toMatchObject({ status: "canceled" });
      expect((await repos.managedMail.account(org))?.change?.completed).toBe(true);
    }
    expect(h.vmCreate).not.toHaveBeenCalled();
    expect(h.provider.createCheckout).toHaveBeenCalledTimes(1);
  },
);
