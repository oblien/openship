import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@repo/core";

const h = vi.hoisted(() => ({
  cloud: false,
  domains: vi.fn(),
  list: vi.fn(),
  renewMail: vi.fn(),
  manage: vi.fn(),
  notify: vi.fn(),
  project: vi.fn(),
  access: vi.fn(),
}));
vi.mock("@repo/db", () => ({
  repos: {
    domain: { findExpiringSsl: h.domains, findByHostname: async () => ({ id: "dom-mail" }) },
    mailServer: { list: h.list },
    project: { findById: h.project },
  },
}));
vi.mock("@repo/platform/engine/modules/billing/management.service", () => ({
  assertManagementAccess: h.access,
}));
vi.mock("@repo/platform/engine/config/env", () => ({
  env: {
    get CLOUD_MODE() {
      return h.cloud;
    },
  },
}));
vi.mock("@repo/platform/engine/lib/domain-ssl", () => ({
  MAIL_DOMAIN_OWNER: "mail",
  manageDomainSsl: h.manage,
  tlsIssuedElsewhere: () => null,
  resolveMailOwner: async () => ({ organizationId: "org-1", serverId: "srv-mail" }),
}));
vi.mock("@repo/platform/engine/modules/mail/mail-certificate.service", () => ({
  renewMailCertificate: h.renewMail,
}));
vi.mock("@repo/platform/engine/lib/notification-dispatcher", () => ({
  notification: { emit: h.notify },
}));
import { renewExpiringCerts } from "@repo/platform/engine/lib/ssl-scheduler";

const mail = () => ({
  serverId: "srv-mail",
  domain: "example.test",
  installedAt: new Date(),
  certificateAutoRenew: true,
  certificateHealth: null,
});
beforeEach(() => {
  vi.clearAllMocks();
  h.cloud = false;
  h.domains.mockResolvedValue([]);
  h.list.mockResolvedValue([mail()]);
  h.renewMail.mockResolvedValue({});
  h.manage.mockResolvedValue({ verified: true });
  h.project.mockResolvedValue({ organizationId: "org-1", name: "Project" });
  h.access.mockResolvedValue(undefined);
});

describe("shared mail certificate scheduler", () => {
  it("repairs legacy mail installs without a domain row", async () => {
    expect(await renewExpiringCerts()).toMatchObject({ renewed: 1 });
    expect(h.renewMail).toHaveBeenCalledWith("srv-mail", true);
  });

  it("never renews mail twice through both its domain and install records", async () => {
    h.domains.mockResolvedValue([{ ownerType: "mail", hostname: "mail.example.test" }]);
    await renewExpiringCerts();
    expect(h.renewMail).toHaveBeenCalledTimes(1);
    expect(h.manage).not.toHaveBeenCalled();
  });

  it("respects disabled renewal even if the mail domain is expired", async () => {
    h.domains.mockResolvedValue([{ ownerType: "mail", hostname: "mail.example.test" }]);
    h.list.mockResolvedValue([{ ...mail(), certificateAutoRenew: false }]);
    expect(await renewExpiringCerts()).toMatchObject({ total: 0 });
    expect(h.renewMail).not.toHaveBeenCalled();
    expect(h.manage).not.toHaveBeenCalled();
  });

  it("notifies the mail server's organization when renewal or reload fails", async () => {
    h.renewMail.mockRejectedValueOnce(new Error("SMTP still serves an expired certificate"));
    expect(await renewExpiringCerts()).toMatchObject({ failed: 1 });
    expect(h.notify).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-1", eventType: "ssl.renewal_failed" }),
    );
  });

  it("renews only paid customer-host certificates in cloud mode, without touching mail or provider TLS", async () => {
    h.cloud = true;
    h.domains.mockResolvedValue([
      { id: "customer", ownerType: "project", projectId: "customer", hostname: "customer.example.test" },
      { id: "provider", ownerType: "project", projectId: "provider", hostname: "provider.example.test" },
      { id: "expired", ownerType: "project", projectId: "expired", hostname: "expired.example.test" },
      { id: "local", ownerType: "project", projectId: "local", hostname: "local.example.test" },
      { id: "mail", ownerType: "mail", projectId: null, hostname: "mail.example.test" },
    ]);
    h.project.mockImplementation(async (id) => ({
      organizationId: "org-1", name: "Project",
      serverId: id === "local" ? null : `server-${id}`,
      workspaceId: id === "provider" ? "cloud-space" : null,
    }));
    h.access.mockImplementation(async (_org, serverId) => {
      if (serverId === "server-expired")
        throw new AppError("Manage expired", 402, "MANAGEMENT_PLAN_REQUIRED");
    });
    expect(await renewExpiringCerts()).toEqual({
      renewed: 1, failed: 0, total: 1,
      details: [{ domain: "customer.example.test", status: "renewed" }],
    });
    expect(h.manage).toHaveBeenCalledExactlyOnceWith("customer.example.test", {
      action: "provision", projectId: "customer",
    });
    expect(h.list).not.toHaveBeenCalled();
    expect(h.renewMail).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("does not mark certificates broken if management expires after selection", async () => {
    h.cloud = true;
    h.domains.mockResolvedValue([
      { id: "customer", projectId: "customer", hostname: "customer.example.test" },
    ]);
    h.project.mockResolvedValue({ organizationId: "org-1", serverId: "server-customer" });
    h.manage.mockRejectedValueOnce(new AppError("Manage expired", 402, "MANAGEMENT_PLAN_REQUIRED"));
    expect(await renewExpiringCerts()).toMatchObject({ renewed: 0, failed: 0, details: [] });
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("leaves certificates unchanged when paid access cannot be verified", async () => {
    h.cloud = true;
    h.domains.mockResolvedValue([
      { id: "customer", projectId: "customer", hostname: "customer.example.test" },
    ]);
    h.project.mockResolvedValue({ organizationId: "org-1", serverId: "server-customer" });
    h.access.mockRejectedValueOnce(new Error("Billing provider unavailable"));
    await expect(renewExpiringCerts()).rejects.toThrow("Billing provider unavailable");
    expect(h.manage).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });
});
