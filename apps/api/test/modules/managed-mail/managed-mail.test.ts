import "../mail/_setup-env";
import { Hono } from "hono";
import { AppError } from "@repo/core";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mailRoutePath } from "../../../src/modules/mail/account-path";
import { managedAccount } from "../../../src/modules/managed-mail/account.controller";

const state = vi.hoisted(() => ({ account: vi.fn(), plan: vi.fn(), engine: vi.fn() }));
vi.mock("../../../src/lib/request-context", () => ({
  getRequestContext: () => ({ organizationId: "org-a" }),
}));
vi.mock("../../../src/lib/permission", () => ({ permission: { assert: vi.fn() } }));
vi.mock("@repo/platform/engine/modules/managed-mail/service", () => ({
  customerEngine: state.account,
  requireMailEntitlement: state.plan,
}));
vi.mock("@repo/platform/engine/modules/managed-mail/engine-client", () => ({
  engineRequest: state.engine,
}));
vi.mock("@repo/platform/engine/lib/provision-lock", () => ({
  createProvisionLock: () => ({ run: (work: () => Promise<unknown>) => work() }),
}));

const app = new Hono();
for (const path of [
  "/admin/:serverId/domains",
  "/admin/:serverId/mailboxes",
  "/admin/:serverId/mailboxes/:email",
]) {
  app.all(path, async (c) =>
    managedAccount(c, path, await state.account("org-a", c.req.param("serverId"))),
  );
}
app.onError((e, c) =>
  c.json({ error: e.message }, e instanceof AppError && e.statusCode === 404 ? 404 : 409),
);
beforeEach(() => {
  state.account.mockImplementation((org, id) => {
    if (org !== "org-a" || id !== "mine") throw new AppError("Unknown service", 404);
    return { hostname: "mail.private.test", serverId: "real" };
  });
  state.plan.mockResolvedValue({ plan: "included" });
});
afterEach(() => vi.resetAllMocks());

it("routes to the bound upstream, and never lists the engine's bootstrap domain", async () => {
  state.engine.mockResolvedValue({
    domains: [{ domain: "private.test" }, { domain: "customer.test" }],
  });
  expect(await (await app.request("/admin/mine/domains?serverId=other")).json()).toEqual({
    domains: [{ domain: "customer.test" }],
  });
  expect(state.engine.mock.calls[0][1]).toBe("/admin/real/domains");
  state.engine.mockClear();
  expect((await app.request("/admin/other/domains")).status).toBe(404);
  expect(state.engine).not.toHaveBeenCalled();
});

it("enforces seats and pooled quota before reaching mailbox creation", async () => {
  state.engine
    .mockResolvedValueOnce({ domains: [{ domain: "customer.test" }] })
    .mockResolvedValueOnce({ mailboxes: [{ username: "old@customer.test", quotaMB: 64 }] });
  const request = () =>
    app.request("/admin/mine/mailboxes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        domain: "customer.test",
        localPart: "new",
        password: "test-mail-password",
      }),
    });
  expect((await request()).status).toBe(409);
  expect(state.engine.mock.calls.every((call) => !call[2])).toBe(true);
  state.engine
    .mockResolvedValueOnce({ domains: [{ domain: "customer.test" }] })
    .mockResolvedValueOnce({ mailboxes: [] })
    .mockResolvedValueOnce({ mailbox: {} });
  expect((await request()).status).toBe(201);
  expect(state.engine.mock.calls.at(-1)?.[3]).toMatchObject({ quotaMB: 1024 });
});
it("rejects a second body domain targeting the bootstrap mailbox and ambiguous path segments", async () => {
  expect(
    await app.request("/admin/mine/mailboxes/postmaster@private.test", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain: "public.test", password: "something" }),
    }),
  ).toHaveProperty("status", 404);
  for (const domain of ["..", "../relay", "%2f", "a\\b"]) {
    expect(() =>
      mailRoutePath("/admin/:serverId/domains/:domain", { domain, serverId: "real" }),
    ).toThrow();
  }
  expect(state.engine).not.toHaveBeenCalled();
});

it.each([
  { placement: "dedicated", dedicated: true, mailboxStorageMB: 4096, reserved: 3900, status: 201 },
  { placement: "dedicated", dedicated: true, mailboxStorageMB: 4096, reserved: 4096, status: 409 },
  {
    placement: "dedicated",
    dedicated: true,
    mailboxStorageMB: undefined,
    reserved: 64,
    status: 409,
  },
  { placement: "dedicated", dedicated: false, mailboxStorageMB: 4096, reserved: 64, status: 409 },
  { placement: "standard", dedicated: true, mailboxStorageMB: 4096, reserved: 64, status: 409 },
])(
  "allocates dedicated disk only to its entitled mailbox host ($placement, $dedicated, $reserved MB)",
  async ({ placement, dedicated, mailboxStorageMB, reserved, status }) => {
    state.account.mockResolvedValue({
      hostname: "mail.private.test",
      serverId: "real",
      placement,
      mailboxStorageMB,
    });
    state.plan.mockResolvedValue({ plan: "solo", dedicated });
    state.engine
      .mockResolvedValueOnce({ domains: [{ domain: "customer.test" }] })
      .mockResolvedValueOnce({
        mailboxes: [{ username: "first@customer.test", quotaMB: reserved }],
      })
      .mockResolvedValueOnce({ mailbox: {} });
    const response = await app.request("/admin/mine/mailboxes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        domain: "customer.test",
        localPart: "second",
        password: "test-mail-password",
      }),
    });
    expect(response.status).toBe(status);
    if (status === 201) expect(state.engine.mock.calls.at(-1)?.[3]).toMatchObject({ quotaMB: 196 });
    else expect(state.engine.mock.calls.every((call) => !call[2])).toBe(true);
  },
);
