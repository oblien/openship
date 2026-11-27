import { beforeEach, expect, it, vi } from "vitest";
import type { Context } from "hono";
import type { ConfigureRelayInput } from "@repo/platform/engine/modules/mail/admin/outbound-relay.service";
import { connectLinkedSending, linkedApiRelayState } from "../../../src/modules/managed-mail/connect-sending";

const h = vi.hoisted(() => ({
  cloud: vi.fn(),
  domain: vi.fn(),
  webmail: vi.fn(),
  state: vi.fn(),
  configure: vi.fn(),
  probe: vi.fn(),
  apiRelay: vi.fn(),
}));
vi.mock("../../../src/modules/mail/account-target", () => ({
  linkedMailRequest: async () =>
    Object.assign(h.cloud, {
      identity: { apiUrl: "https://cloud.example", organizationId: "org-cloud" },
    }),
}));
vi.mock("../../../src/lib/request-context", () => ({
  getRequestContext: () => ({ organizationId: "org-local" }),
}));
vi.mock("../../../src/modules/mail/webmail/sending-settings", () => ({
  linkedWebmailSending: h.webmail,
}));
vi.mock("@repo/platform/engine/lib/provision-lock", () => ({
  createProvisionLock: () => ({ run: (work: () => unknown) => work() }),
}));
vi.mock("@repo/platform/engine/modules/mail/admin/api-relay", () => ({ mailApiRelay: h.apiRelay }));
vi.mock("@repo/platform/engine/modules/mail/admin/domains.service", () => ({
  getDomain: h.domain,
}));
vi.mock("@repo/platform/engine/lib/resource-access", () => ({ isServerInOrg: async () => true }));
vi.mock("@repo/platform/engine/modules/mail/mail-engine", () => ({
  requireMailEngine: async () => ({ flavor: "container" }),
  mailEngineCommand: (_flavor: string, command: string) => command,
}));
vi.mock("@repo/platform/engine/lib/ssh-manager", () => ({
  sshManager: {
    withExecutor: (_id: string, fn: (exec: object) => unknown) => fn({ exec: h.probe }),
  },
}));
vi.mock("@repo/platform/engine/modules/mail/mail-state", () => ({ readState: h.state }));
vi.mock("@repo/platform/engine/lib/encryption", () => ({ decrypt: () => "smtp-secret" }));
vi.mock("@repo/platform/engine/modules/mail/admin/outbound-relay.service", () => ({
  configureOutboundRelay: h.configure,
}));
const ctx = {} as Context;
beforeEach(() => {
  vi.resetAllMocks();
  h.domain.mockResolvedValue({ active: true });
});

it("installs the Cloud API key without a provider namespace and reuses it after reload", async () => {
  let installed: { keyId: string; apiOrigin: string } | null = null;
  h.cloud.mockImplementation(async (path: string) => {
    if (path === "/sending/domains/domain") return { domain: "example.net", state: "ready" };
    if (path === "/sending/keys")
      return { data: installed ? [{ id: "pat_email", domainId: "domain" }] : [] };
    if (path === "/sending/domains/domain/key")
      return { id: "pat_email", key: "opsh_send_fixture" };
    throw new Error("Unexpected request");
  });
  h.webmail.mockImplementation(async (_ctx, _server, _domain, settings) => {
    if (!settings) return { sending: installed };
    expect(settings).toEqual({
      apiOrigin: "https://cloud.example",
      keyId: "pat_email",
      key: "opsh_send_fixture",
    });
    installed = { keyId: settings.keyId, apiOrigin: settings.apiOrigin };
    return { configured: true };
  });
  for (let i = 0; i < 2; i++)
    expect(await connectLinkedSending(ctx, "vps", "domain")).toEqual({ configured: true });
  expect(h.cloud.mock.calls.filter(([path]) => path.endsWith("/key"))).toHaveLength(1);
  expect(h.configure).not.toHaveBeenCalled();
});

it("enables Postfix without webmail, retains previously enabled domains and reuses the SMTP credential", async () => {
  let saved:
    | (Omit<ConfigureRelayInput, "password"> & { passwordEncrypted: string; enabled: true })
    | undefined;
  h.state.mockImplementation(async () => ({ outboundRelay: saved }));
  h.configure.mockImplementation(async (_exec, { password, ...input }) => {
    expect(password).toBe("smtp-secret");
    saved = { ...input, enabled: true, passwordEncrypted: "cipher" };
  });
  h.cloud.mockImplementation(async (path: string, init: RequestInit) => {
    const domain = path.split("/")[3];
    if (path.endsWith("/smtp-key")) {
      const { installation, installedId } = JSON.parse(String(init.body));
      expect(installation).toMatch(/^[a-f0-9]{64}$/);
      return {
        id: "smtp-id",
        namespace: "tenant",
        ...(installedId ? {} : { secret: "smtp-secret" }),
      };
    }
    return { domain: domain + ".test", state: "ready" };
  });
  for (const domain of ["one", "two", "two"])
    await connectLinkedSending(ctx, "vps", domain, "smtp");
  expect(saved).toMatchObject({
    domains: ["one.test", "two.test"],
    scope: "selected",
    host: "smtp.oblien.com",
    port: 587,
  });
  expect(h.configure).toHaveBeenCalledTimes(2);
  expect(h.webmail).not.toHaveBeenCalled();
});

it("leaves an existing custom relay alone and requires a local verified domain", async () => {
  h.cloud.mockResolvedValue({ domain: "example.net", state: "ready" });
  h.state.mockResolvedValue({ outboundRelay: { enabled: true, provider: "custom" } });
  await expect(connectLinkedSending(ctx, "vps", "domain", "smtp")).rejects.toThrow(
    "current SMTP relay",
  );
  h.domain.mockResolvedValue({ active: false });
  await expect(connectLinkedSending(ctx, "vps", "domain", "smtp")).rejects.toThrow("sender domain");
  expect(h.configure).not.toHaveBeenCalled();
  expect(h.cloud.mock.calls.every(([path]) => path === "/sending/domains/domain")).toBe(true);
});

it("checks authenticated STARTTLS availability from the selected mail server before issuing any SMTP credential", async () => {
  h.cloud.mockResolvedValue({ domain: "example.net", state: "ready" });
  h.state.mockResolvedValue({});
  h.probe.mockRejectedValue(new Error("unreachable"));
  await expect(connectLinkedSending(ctx, "vps", "domain", "smtp")).rejects.toThrow(
    "could not connect securely",
  );
  expect(h.probe).toHaveBeenCalledWith(
    expect.stringContaining("starttls(context=ssl.create_default_context())"),
    expect.any(Object),
  );
  expect(h.cloud).toHaveBeenCalledTimes(1);
  expect(h.configure).not.toHaveBeenCalled();
});

it("manages a linked Postfix API relay independently of webmail and revokes its key on disconnect", async () => {
  let keyId: string | null = null;
  h.cloud.mockImplementation(async (path, options) => {
    if (path === "/sending/domains/domain") return { domain: "example.net", state: "ready" };
    if (path === "/sending/keys") return { data: keyId ? [{ id: keyId, domainId: "domain" }] : [] };
    if (path === "/sending/domains/domain/key") return { id: "pat_relay", key: "opsh_send_test" };
    if (path === "/sending/keys/pat_relay" && options.method === "DELETE") return { revoked: true };
    throw new Error("Unexpected operation");
  });
  h.apiRelay.mockImplementation(async (server, domain, authority, change) => {
    expect([server, domain, authority]).toEqual(["vps", "example.net", {
      apiOrigin: "https://cloud.example", namespace: expect.stringMatching(/^openship-mail-[a-f0-9]{32}$/),
    }]);
    if (change === "remove") keyId = null;
    else if (change) {
      expect(change).toEqual({ keyId: "pat_relay", key: "opsh_send_test" });
      keyId = change.keyId;
    }
    return keyId ? { keyId, binding: "fixture" } : null;
  });
  for (let i = 0; i < 2; i++) await connectLinkedSending(ctx, "vps", "domain", "api-relay");
  expect(h.cloud.mock.calls.filter(([path]) => path.endsWith("/key"))).toHaveLength(1);
  expect(await linkedApiRelayState(ctx, "vps", "domain", false)).toEqual({ keyId: "pat_relay" });
  expect(await linkedApiRelayState(ctx, "vps", "domain", true)).toEqual({ keyId: null });
  expect(h.cloud).toHaveBeenCalledWith("/sending/keys/pat_relay", { method: "DELETE" });
  expect(h.configure).not.toHaveBeenCalled();
  expect(h.webmail).not.toHaveBeenCalled();
});
