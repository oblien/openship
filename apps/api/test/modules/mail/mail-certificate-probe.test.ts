import "./_setup-env";
import { X509Certificate } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTestCert } from "../../../../../packages/adapters/src/system/proxy/test-certs";
import { currentMailCertificateHealth } from "@repo/core";
import {
  parseMailCertificateProbe,
  configureMailCertificate,
  retireLegacyMailRenewal,
} from "@repo/platform/engine/modules/mail/mail-certificate-probe";

const HOST = "mail.example.test";
const good = makeTestCert([HOST], { days: 90 });
const other = makeTestCert([HOST], { days: 80 });
const short = makeTestCert([HOST], { days: 1 });
const wrong = makeTestCert(["wrong.example.test"], { days: 90 });
const engine = vi.hoisted(() => ({ flavor: "host" as "host" | "container" }));
vi.mock("@repo/platform/engine/modules/mail/mail-engine", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/modules/mail/mail-engine")>()),
  requireMailEngine: async () => ({ flavor: engine.flavor }),
  resolveMailMutationAccess: async (executor: unknown) => ({
    hostFiles: executor,
    engineExec: executor,
  }),
}));

const section = (name: string, body: string) =>
  `OPENSHIP_CERT_${name}_BEGIN\n${body}\nOPENSHIP_CERT_${name}_END\n`;
function output(disk = good.certPem, smtp = disk, imap = disk, trusted = true) {
  const tls = (pem: string) =>
    `${pem}\nVerify return code: ${trusted ? "0 (ok)" : "18 (self-signed certificate)"}\n`;
  return (
    section("disk", disk) +
    section("smtp", tls(smtp)) +
    section("smtps", tls(smtp)) +
    section("imap", tls(imap))
  );
}

afterEach(() => {
  vi.useRealTimers();
  engine.flavor = "host";
});

describe("mail certificate observations", () => {
  it("requires the disk, submission and IMAP certificates to agree", () => {
    const health = parseMailCertificateProbe(HOST, output());
    expect(health.status).toBe("ok");
    expect(health.endpoints.map((p) => p.port)).toEqual([587, 465, 993]);
    expect(
      health.endpoints.every(
        (p) => p.trusted && p.certificate?.fingerprint === health.certificate?.fingerprint,
      ),
    ).toBe(true);
  });

  it("detects renewed files with a stale SMTP or IMAP daemon", () => {
    expect(parseMailCertificateProbe(HOST, output(good.certPem, other.certPem))).toMatchObject({
      status: "fail",
      reason: "not_loaded",
    });
    expect(
      parseMailCertificateProbe(HOST, output(good.certPem, good.certPem, other.certPem)),
    ).toMatchObject({ status: "fail", reason: "not_loaded" });
  });

  it("rejects an untrusted chain or a certificate for another hostname", () => {
    expect(
      parseMailCertificateProbe(HOST, output(good.certPem, good.certPem, good.certPem, false)),
    ).toMatchObject({ status: "fail", reason: "untrusted" });
    expect(parseMailCertificateProbe(HOST, output(wrong.certPem))).toMatchObject({
      status: "fail",
      reason: "untrusted",
    });
  });

  it("detects expiry even when OpenSSL parsed the certificate successfully", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(new X509Certificate(short.certPem).validTo).getTime() + 1000);
    expect(parseMailCertificateProbe(HOST, output(short.certPem))).toMatchObject({
      status: "fail",
      reason: "expired",
    });
  });

  it("does not call a failed TLS probe healthy", () => {
    expect(
      parseMailCertificateProbe(HOST, output(good.certPem, "connect: Connection refused")),
    ).toMatchObject({ status: "unknown", reason: "unavailable" });
    expect(parseMailCertificateProbe(HOST, section("disk", "OPENSHIP_CERT_MISSING"))).toMatchObject(
      { status: "fail", reason: "missing" },
    );
  });

  it("regrades old snapshots instead of leaving the issue feed green indefinitely", () => {
    const health = parseMailCertificateProbe(HOST, output());
    expect(currentMailCertificateHealth(health, 14, Date.now() + 2 * 86_400_000)).toMatchObject({
      status: "unknown",
    });
    expect(
      currentMailCertificateHealth(
        health,
        14,
        new Date(health.certificate!.expiresAt).getTime() + 1,
      ),
    ).toMatchObject({ status: "fail", reason: "expired" });
  });
});

describe("mail certificate wiring", () => {
  it.each(["host", "container"] as const)(
    "propagates a daemon reload failure on %s mail",
    async (flavor) => {
      engine.flavor = flavor;
      const executor = {
        exec: vi.fn(async (command: string) => {
          if (command.includes("doveadm reload")) throw new Error("Dovecot reload failed");
          return "";
        }),
      };
      await expect(configureMailCertificate(executor as never, HOST)).rejects.toThrow(
        "Dovecot reload failed",
      );
      const command = executor.exec.mock.calls.at(-1)![0];
      expect(command.includes("docker exec")).toBe(flavor === "container");
    },
  );

  it("leaves unrelated legacy renewals alone", async () => {
    const executor = {
      exec: vi.fn(async (command: string) => {
        if (command.startsWith("systemctl is-enabled")) return "enabled\n";
        throw new Error("The host Certbot timer also manages other certificates");
      }),
    };
    await expect(retireLegacyMailRenewal(executor as never, HOST)).rejects.toThrow(
      "other certificates",
    );
  });
});
