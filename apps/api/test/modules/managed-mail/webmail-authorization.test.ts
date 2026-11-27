import "../mail/_setup-env";
import { Hono } from "hono";
import { AppError } from "@repo/core";
import { afterEach, expect, it, vi } from "vitest";
import {
  bindWebmailHosting,
  linkedWebmailSending,
  sendingSettingsSchema,
} from "../../../src/modules/mail/webmail/sending-settings";

const state = vi.hoisted(() => ({
  authorize: vi.fn(),
  summary: vi.fn(),
  initialize: vi.fn(),
  assertDomain: vi.fn(),
  relay: vi.fn(),
  apiRelay: vi.fn(),
  appOnVm: false,
  exec: vi.fn(),
}));
vi.mock("../../../src/lib/request-context", () => ({
  getRequestContext: () => ({ organizationId: "owner", principalKind: "pat", sessionId: "pat:operator" }),
}));
vi.mock("../../../src/lib/permission", () => ({ permission: { assert: state.authorize } }));
vi.mock("@repo/db", () => ({
  repos: {
    mailServer: { get: async () => ({ webmailProjectId: state.appOnVm ? null : "webmail" }) },
    server: { getInOrganization: async () => ({ sshHost: "vm", workspaceId: null }) },
    service: { listByProject: async () => [{ name: "webmail", id: "service" }] },
    project: { getEnvMap: async () => ({ OPENSHIP_SENDING_ADMIN_TOKEN: "encrypted" }) },
  },
}));
vi.mock("@repo/platform/engine/modules/mail/webmail/webmail-install.service", () => ({
  resolveWebmailSummary: state.summary,
}));
vi.mock("@repo/platform/engine/modules/mail/admin/tenant-domains", () => ({
  initializeSharedDomains: state.initialize,
  assertTenantDomain: state.assertDomain,
}));
vi.mock("@repo/platform/engine/modules/mail/admin/api-relay", () => ({
  mailApiRelay: state.apiRelay, mailApiRelayAvailable: async () => true,
}));
vi.mock("@repo/platform/engine/modules/mail/admin/shared-relay", () => ({
  configureSharedRelay: state.relay,
}));

vi.mock("@repo/platform/engine/lib/encryption", () => ({ decrypt: () => "webmail-token" }));
vi.mock("@repo/platform/engine/lib/ssh-manager", () => ({ sshManager: { withExecutor: async (_id: string, fn: Function) => fn({ execWithInput: state.exec }) } }));
afterEach(() => {
  state.appOnVm = false;
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it("requires project admin before binding shared hosting or changing sender credentials", async () => {
  state.authorize.mockImplementation(async (_ctx, resource) => {
    if (resource.resourceType === "project") throw new AppError("Project access denied", 403);
  });
  const ns = "openship-mail-" + "a".repeat(32);
  const app = new Hono()
    .onError((error, c) =>
      c.json({}, error instanceof AppError && error.statusCode === 403 ? 403 : 500),
    )
    .put("/hosting", async (c) =>
      c.json(await bindWebmailHosting(c, "server", { shared: true, imapHost: "mail.host.test" })),
    )
    .put("/tenants/:mailTenant/sending", async (c) =>
      c.json(
        await linkedWebmailSending(c, "server", "customer.test", {
          namespace: ns,
          key: "provider-secret",
          keyId: "id",
        }),
      ),
    );
  for (const path of ["/hosting", "/tenants/" + ns + "/sending"]) {
    expect((await app.request(path, { method: "PUT" })).status).toBe(403);
    expect(state.authorize).toHaveBeenLastCalledWith(expect.anything(), {
      resourceType: "project",
      resourceId: "webmail",
      action: "admin",
    });
  }
  expect(state.assertDomain).not.toHaveBeenCalled();
  expect(state.initialize).not.toHaveBeenCalled();
  expect(state.relay).not.toHaveBeenCalled();
  expect(state.summary).not.toHaveBeenCalled();
});

it("requires webmail to be on the assigned mail VM before confirming dedicated placement", async () => {
  const binding = { namespace: "openship-mail-" + "a".repeat(32), dedicated: true as const, imapHost: "mail.host.test" };
  const fetch = vi.fn(() => Promise.resolve(Response.json({ bound: true })));
  vi.stubGlobal("fetch", fetch);
  const app = new Hono()
    .onError((error, c) => c.json({}, error instanceof AppError && error.statusCode === 409 ? 409 : 500))
    .put("/hosting", async c => c.json(await bindWebmailHosting(c, "server", binding)));
  const webmail = { installed: true, url: "https://webmail.host.test", projectId: "webmail" };
  for (const placement of [{}, { serverId: "other" }, { serverId: "server", workspaceId: "remote" }]) {
    state.summary.mockResolvedValue({ ...webmail, ...placement });
    expect((await app.request("/hosting", { method: "PUT" })).status).toBe(409);
  }
  expect(fetch).not.toHaveBeenCalled();
  state.summary.mockResolvedValue({ ...webmail, serverId: "server" });
  expect((await app.request("/hosting", { method: "PUT" })).status).toBe(200);
  expect(fetch).toHaveBeenCalledWith(new URL("https://webmail.host.test/admin/hosting"),
    expect.objectContaining({ body: JSON.stringify(binding) }));
});

it("returns only sending metadata and reports an invalid webmail reply as an upstream failure", async () => {
  state.summary.mockResolvedValue({
    installed: true,
    url: "https://webmail.host.test",
    projectId: "webmail",
  });
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ sending: { keyId: "key-id", namespace: "tenant", key: "private" } }),
    )
    .mockResolvedValueOnce(Response.json({ configured: true }));
  vi.stubGlobal("fetch", fetch);
  const app = new Hono()
    .onError((error, c) =>
      c.json({}, error instanceof AppError && error.statusCode === 502 ? 502 : 500),
    )
    .get("/sending", async (c) => c.json(await linkedWebmailSending(c, "server", "customer.test")));
  expect(await (await app.request("/sending")).json()).toEqual({
    sending: { keyId: "key-id", namespace: "tenant" },
  });
  expect(fetch).toHaveBeenCalledWith(
    new URL("https://webmail.host.test/admin/sending/customer.test"),
    expect.objectContaining({
      method: "GET",
      headers: expect.objectContaining({ "x-openship-sending-token": "webmail-token" }),
    }),
  );
  expect((await app.request("/sending")).status).toBe(502);
});

it.each(["opsh_pat_fixture", "opsh_send_fixture"])("checks the domain and namespace before installing %s on both transports", async (key) => {
  state.summary.mockResolvedValue({ installed: true, url: "https://webmail.host.test", projectId: "webmail" });
  const { cloudRuntimeTarget } = await import("@repo/core");
  const apiOrigin = new URL(cloudRuntimeTarget.api).origin;
  const namespace = "openship-mail-" + "a".repeat(32);
  const other = "openship-mail-" + "b".repeat(32);
  const settings = { namespace, key, keyId: "pat_fixture" };
  expect(sendingSettingsSchema.safeParse({ ...settings, apiOrigin }).success).toBe(true);
  expect(sendingSettingsSchema.safeParse({ ...settings, apiOrigin: "https://other.test" }).success).toBe(false);
  expect(sendingSettingsSchema.safeParse({ ...settings, apiOrigin, key: "provider-fixture" }).success).toBe(false);
  const fetch = vi.fn(async () => Response.json({ configured: true }));
  vi.stubGlobal("fetch", fetch);
  const app = new Hono()
    .onError((err, c) => c.json({}, err instanceof AppError && err.statusCode === 409 ? 409 : 404))
    .put("/tenants/:mailTenant", async c =>
      c.json(await linkedWebmailSending(c, "server", "customer.test", settings)));
  expect((await app.request("/tenants/" + other, { method: "PUT" })).status).toBe(409);
  state.assertDomain.mockRejectedValueOnce(new AppError("Missing domain", 404));
  expect((await app.request("/tenants/" + namespace, { method: "PUT" })).status).toBe(404);
  expect(state.apiRelay).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  const response = await app.request("/tenants/" + namespace, { method: "PUT" });
  expect(await response.json()).toEqual({ configured: true });
  expect(state.apiRelay).toHaveBeenCalledTimes(2);
  expect(state.apiRelay).toHaveBeenLastCalledWith("server", "customer.test",
    { namespace, apiOrigin }, { key: settings.key, keyId: settings.keyId });
  expect(fetch).toHaveBeenCalledWith(new URL("https://webmail.host.test/admin/sending/customer.test"),
    expect.objectContaining({ body: JSON.stringify({ ...settings, apiOrigin }), redirect: "error" }));
  expect(state.relay).not.toHaveBeenCalled();
});

it("binds a customer App through its VM with operator authority and rejects tenant delegation", async () => {
  state.appOnVm = true;
  const namespace = "openship-mail-" + "a".repeat(32);
  const input = { dedicated: true as const, customerProjectId: "proj_1", namespace, imapHost: "mail.private.test" };
  const headers = { "x-openship-webmail-project": input.customerProjectId };
  const app = new Hono().onError((e,c) => c.json({}, e instanceof AppError && e.statusCode === 403 ? 403 : 500))
    .put("/hosting", async c => c.json(await bindWebmailHosting(c, "server", input)))
    .get("/tenants/:mailTenant/sending", async c => c.json(await linkedWebmailSending(c, "server", "private.test")));
  expect((await app.request("/tenants/" + namespace + "/sending", { headers })).status).toBe(403);
  state.authorize.mockImplementation(async (_ctx, resource) => {
    if (resource.resourceType === "server") throw new AppError("Denied", 403);
  });
  expect((await app.request("/hosting", { method: "PUT", headers })).status).toBe(403);
  expect(state.exec).not.toHaveBeenCalled();
  state.authorize.mockResolvedValue(undefined);
  state.exec.mockImplementation(async (cmd, stdin) => {
    expect(cmd).toContain("label=openship.project=proj_1");
    expect(cmd).toContain("label=openship.service=webmail");
    expect(cmd).not.toContain(namespace);
    const chunks = [];
    for await (const chunk of stdin) chunks.push(chunk);
    expect(JSON.parse(chunks.join(""))).toEqual({ path: "/admin/hosting", body: { namespace, imapHost: input.imapHost, dedicated: true } });
    return { code: 0, stdout: JSON.stringify({ bound: true }), stderr: "" };
  });
  expect(await (await app.request("/hosting", { method: "PUT", headers })).json()).toEqual({ bound: true, apiRelay: true });
  expect(state.exec).toHaveBeenCalledOnce();
  expect(state.summary).not.toHaveBeenCalled();
});
