import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MailCertificateHealth } from "@repo/core";

const h = vi.hoisted(() => ({
  cloud: false,
  mail: {} as Record<string, any>,
  get: vi.fn(),
  check: vi.fn(),
  configure: vi.fn(),
  retire: vi.fn(),
  manage: vi.fn(),
  ensure: vi.fn(),
  record: vi.fn(),
  withExecutor: vi.fn(),
  error: vi.fn(),
  toggle: vi.fn(),
  job: { enabled: true, cronExpression: "17 3 * * *", scheduleType: "recurring" },
}));
vi.mock("@repo/db", () => ({
  withAdvisoryLock: (_key: string, fn: () => unknown) => fn(),
  repos: {
    mailServer: {
      get: h.get,
      setCertificateHealth: async (_id: string, health: MailCertificateHealth) => {
        h.mail.certificateHealth = health;
      },
      setCertificateRenewalError: h.error,
      setCertificateAutoRenew: h.toggle,
    },
    job: { findByKey: async () => h.job },
  },
}));
vi.mock("@repo/platform/engine/config/env", () => ({
  env: {
    get CLOUD_MODE() {
      return h.cloud;
    },
    DEPLOY_MODE: "desktop",
  },
}));
vi.mock("@repo/platform/engine/lib/ssh-manager", () => ({
  sshManager: { withExecutor: h.withExecutor },
}));
vi.mock("@repo/platform/engine/lib/domain-ssl", () => ({
  manageDomainSsl: h.manage,
  ensureMailCertDomain: h.ensure,
  recordMailCertDomain: h.record,
  resolveMailOwner: async () => ({ serverId: "srv-mail" }),
}));
vi.mock("@repo/platform/engine/modules/mail/mail-certificate-probe", () => ({
  checkMailCertificate: h.check,
  configureMailCertificate: h.configure,
  retireLegacyMailRenewal: h.retire,
}));

import {
  applyMailCertificate,
  refreshMailCertificate,
  renewMailCertificate,
  setMailCertificateAutoRenew,
} from "@repo/platform/engine/modules/mail/mail-certificate.service";

const healthy = (): MailCertificateHealth => ({
  hostname: "mail.example.test",
  status: "ok",
  checkedAt: new Date().toISOString(),
  endpoints: [],
  certificate: {
    expiresAt: new Date(Date.now() + 60 * 86_400_000).toISOString(),
    issuer: "test",
    fingerprint: "test",
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  h.cloud = false;
  h.mail = {
    serverId: "srv-mail",
    domain: "example.test",
    installedAt: new Date(),
    certificateAutoRenew: true,
    certificateHealth: null,
    certificateRenewalError: null,
  };
  h.get.mockImplementation(async () => h.mail);
  h.withExecutor.mockImplementation(async (_id, fn) => fn({}));
  h.check.mockImplementation(async () => healthy());
  h.manage.mockResolvedValue({ verified: true, expiresAt: new Date(Date.now() + 60 * 86_400_000).toISOString() });
  h.error.mockImplementation(async (_id, error) => {
    h.mail.certificateRenewalError = error;
  });
  h.toggle.mockImplementation(async (_id, value) => {
    h.mail.certificateAutoRenew = value;
  });
});

describe("mail certificate lifecycle", () => {
  it("coalesces Health and Advanced requests and caches their observation", async () => {
    const [one, two] = await Promise.all([
      refreshMailCertificate("srv-mail"),
      refreshMailCertificate("srv-mail"),
    ]);
    expect(one).toEqual(two);
    await refreshMailCertificate("srv-mail");
    expect(h.check).toHaveBeenCalledTimes(1);
    await refreshMailCertificate("srv-mail", { force: true });
    expect(h.check).toHaveBeenCalledTimes(2);
  });

  it("does no renewal work after auto-renew has been disabled", async () => {
    h.mail.certificateAutoRenew = false;
    expect(await renewMailCertificate("srv-mail", true)).toBeNull();
    expect(h.withExecutor).not.toHaveBeenCalled();
    expect(h.manage).not.toHaveBeenCalled();
  });

  it("rediscovers a healthy legacy certificate without opening a new order", async () => {
    expect(await renewMailCertificate("srv-mail", true)).toBeNull();
    expect(h.ensure).toHaveBeenCalledWith("mail.example.test");
    expect(h.record).toHaveBeenCalledOnce();
    expect(h.manage).not.toHaveBeenCalled();
  });

  it("routes manual repair through the shared SSL lifecycle with an authorized mail server", async () => {
    await renewMailCertificate("srv-mail");
    expect(h.manage).toHaveBeenCalledWith("mail.example.test", {
      action: "provision",
      mailServerId: "srv-mail",
    });
  });

  it("routes due automatic renewal through the same lifecycle", async () => {
    h.check.mockResolvedValue({ ...healthy(), status: "warn", reason: "expiring" });
    await renewMailCertificate("srv-mail", true);
    expect(h.manage).toHaveBeenCalledWith("mail.example.test", {
      action: "provision",
      mailServerId: "srv-mail",
    });
  });

  it("does not spend an ACME attempt on an inconclusive SMTP check", async () => {
    h.check.mockResolvedValue({
      ...healthy(),
      status: "unknown",
      reason: "unavailable",
      detail: "SMTP unavailable",
    });
    await expect(renewMailCertificate("srv-mail", true)).rejects.toThrow("SMTP unavailable");
    expect(h.manage).not.toHaveBeenCalled();
    expect(h.error).toHaveBeenCalledWith("srv-mail", "SMTP unavailable");
  });

  it("fails when a daemon keeps serving the old certificate after reload", async () => {
    h.check.mockResolvedValue({
      ...healthy(),
      status: "fail",
      reason: "not_loaded",
      detail: "Stale SMTP certificate",
    });
    await expect(applyMailCertificate("srv-mail", "mail.example.test")).rejects.toThrow(
      "Stale SMTP certificate",
    );
    expect(h.error).toHaveBeenCalledWith("srv-mail", "Stale SMTP certificate");
  });

  it("does not silently save the renewal switch when legacy ownership cannot be migrated", async () => {
    h.retire.mockRejectedValueOnce(new Error("Other certificates use this timer"));
    await expect(setMailCertificateAutoRenew("srv-mail", false)).rejects.toThrow(
      "Other certificates",
    );
    expect(h.toggle).not.toHaveBeenCalled();
  });

  it("never reads or executes mail operations in cloud mode", async () => {
    h.cloud = true;
    expect(await refreshMailCertificate("srv-mail")).toBeNull();
    await expect(renewMailCertificate("srv-mail")).rejects.toThrow();
    expect(h.get).not.toHaveBeenCalled();
    expect(h.withExecutor).not.toHaveBeenCalled();
  });
});
