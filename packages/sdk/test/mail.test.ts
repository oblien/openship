import { describe, expect, it } from "vitest";
import { SDK_CAPABILITIES } from "@repo/contracts";
import { OpenshipClient, ApiError } from "../src/client";

function fixture(reply: (url: URL, request: RequestInit) => Response) {
  const calls: Array<{ url: URL; request: RequestInit }> = [];
  const ship = new OpenshipClient({
    baseUrl: "https://controller.example.test/control",
    token: "opsh_pat_mail",
    organizationId: "org_mail",
    fetch: async (url, request = {}) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/control/api/health")
        return Response.json({ sdk: SDK_CAPABILITIES });
      calls.push({ url: parsed, request });
      return reply(parsed, request);
    },
  });
  return { ship, calls };
}
const certificate = {
  serverId: "srv_mail",
  hostname: "mail.example.com",
  autoRenew: true,
  renewalJobEnabled: true,
  desktop: false,
  lastRenewalError: null,
  health: null,
};

describe("mail administration uses the existing authenticated controller", () => {
  it("preserves scope and encoding and sends destructive flags as query parameters", async () => {
    const f = fixture(() => Response.json({ ok: true, mode: "soft" }));
    await f.ship.mail.removeMailbox("srv/one", "user+ops@example.com", { hard: false });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url.pathname).toBe(
      "/control/api/mail/admin/srv%2Fone/mailboxes/user%2Bops%40example.com",
    );
    expect(f.calls[0].url.search).toBe("?hard=false");
    expect(f.calls[0].request.body).toBeUndefined();
    expect(new Headers(f.calls[0].request.headers).get("x-organization-id")).toBe("org_mail");
    expect(new Headers(f.calls[0].request.headers).get("x-openship-scope")).toBe("fixed");
    expect(new Headers(f.calls[0].request.headers).get("authorization")).toBe(
      "Bearer opsh_pat_mail",
    );
  });

  it("requires a domain filter instead of advertising an unsupported unfiltered mailbox list", async () => {
    const f = fixture(() => Response.json({ mailboxes: [] }));
    // @ts-expect-error The same missing-input error must be caught for JavaScript callers.
    await expect(f.ship.mail.listMailboxes("srv_mail")).rejects.toThrow();
    expect(f.calls).toEqual([]);
    expect(await f.ship.mail.listMailboxes("srv_mail", { domain: "example.com" })).toEqual([]);
    expect(f.calls[0].url.search).toBe("?domain=example.com");
  });

  it("keeps DNS warnings from a successfully created mail domain", async () => {
    const response = {
      domain: {
        domain: "example.com",
        description: "",
        mailboxes: 0,
        aliases: 0,
        maxMailboxes: 5,
        maxAliases: 0,
        defaultQuotaMB: 100,
        active: true,
        createdAt: "2026-10-07T00:00:00Z",
      },
      dnsWarning: "Publish DKIM manually",
    };
    const f = fixture(() => Response.json(response));
    expect(
      await f.ship.mail.createDomain("srv_mail", { domain: "example.com", maxMailboxes: 5 }),
    ).toEqual(response);
    expect(JSON.parse(String(f.calls[0].request.body))).toEqual({
      domain: "example.com",
      maxMailboxes: 5,
    });
  });

  it("renews and configures certificates through the shared mail certificate routes", async () => {
    const f = fixture(() => Response.json(certificate));
    await f.ship.mail.renewCertificate("srv_mail");
    await f.ship.mail.updateCertificate("srv_mail", { autoRenew: false });
    expect(f.calls.map((call) => [call.request.method, call.url.pathname])).toEqual([
      ["POST", "/control/api/mail/admin/srv_mail/certificate/renew"],
      ["PATCH", "/control/api/mail/admin/srv_mail/certificate"],
    ]);
    expect(JSON.parse(String(f.calls[1].request.body))).toEqual({ autoRenew: false });
  });

  it("does not substitute an empty policy for a missing mail backup configuration", async () => {
    const f = fixture(() => Response.json({ policy: null }));
    expect(await f.ship.mail.getBackupPolicy("srv_mail")).toBeNull();
  });

  it("preserves omitted retention versus explicit unlimited retention at the shared backup boundary", async () => {
    const f = fixture(() =>
      Response.json(
        { error: "Fixture stops before the write", code: "REVIEW_REQUIRED" },
        { status: 409 },
      ),
    );
    await expect(
      f.ship.mail.saveBackupPolicy("srv_mail", { destinationId: "dst_mail" }),
    ).rejects.toThrow();
    await expect(
      f.ship.mail.saveBackupPolicy("srv_mail", {
        destinationId: "dst_mail",
        retainCount: null,
        retainDays: null,
      }),
    ).rejects.toThrow();
    expect(f.calls.map((call) => JSON.parse(String(call.request.body)))).toEqual([
      { destinationId: "dst_mail" },
      { destinationId: "dst_mail", retainCount: null, retainDays: null },
    ]);
  });

  it("rejects unexpected plaintext or encrypted relay credentials without attaching them to errors", async () => {
    const secret = "fixture-password-must-not-leak";
    const f = fixture(() =>
      Response.json({
        relay: {
          enabled: true,
          provider: "custom",
          host: "smtp.example.com",
          port: 587,
          username: "mail",
          hasPassword: true,
          updatedAt: "2026-10-07T00:00:00Z",
          passwordEncrypted: secret,
        },
      }),
    );
    const error = await f.ship.mail.getRelay("srv_mail").catch((error) => error);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(502);
    expect(error.body).toBeNull();
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("passes authorization failures through without trying another tenant or endpoint", async () => {
    const f = fixture(() =>
      Response.json({ error: "Access denied", code: "FORBIDDEN" }, { status: 403 }),
    );
    await expect(f.ship.mail.getCertificate("srv_other")).rejects.toMatchObject({ status: 403 });
    expect(f.calls).toHaveLength(1);
  });

  it("never replaces a legacy webmail install automatically after a conflict", async () => {
    const f = fixture(() =>
      Response.json(
        { error: "Explicit replacement required", code: "LEGACY_WEBMAIL" },
        { status: 409 },
      ),
    );
    await expect(
      f.ship.mail.deployWebmail({
        mailServerId: "srv_mail",
        hostname: "inbox.example.com",
        target: { kind: "self", serverId: "srv_web" },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.calls).toHaveLength(1);
    expect(JSON.parse(String(f.calls[0].request.body))).not.toHaveProperty("replaceLegacy");
  });

  it("validates component actions and setup configuration before dispatch", async () => {
    const f = fixture(() => {
      throw new Error("No request expected");
    });
    // @ts-expect-error JavaScript input must be checked too.
    await expect(
      f.ship.mail.componentAction("srv_mail", "postfix", { action: "restart/other" }),
    ).rejects.toThrow();
    expect(() =>
      f.ship.mail.setup({
        serverId: "srv_mail",
        domain: "example.com",
        config: { adminPassword: "x\nINJECTED=value" },
      }),
    ).toThrow();
    expect(f.calls).toEqual([]);
  });

  it("returns DNS checkpoints without automatically acknowledging or restarting setup", async () => {
    const f = fixture(
      () =>
        new Response('event: dns_pending\ndata: {"resumeStep":12,"records":{}}\n\n', {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const events = [];
    for await (const event of f.ship.mail.setup({
      serverId: "srv_mail",
      domain: "example.com",
      startStep: 11,
    }))
      events.push(event);
    expect(events).toMatchObject([
      { event: "dns_pending", data: '{"resumeStep":12,"records":{}}' },
    ]);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url.pathname).toBe("/control/api/mail/setup");
  });
});
