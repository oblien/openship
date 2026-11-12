import "./_setup-env";
import { describe, expect, it } from "vitest";
import { createEncryption } from "@repo/db/encryption";
import { makeFreshState } from "@repo/platform/engine/modules/mail/mail-state";
import { exportMailState, importMailState } from "@repo/platform/engine/modules/mail/backup-state";

describe("mail configuration transferred between instances", () => {
  it("re-encrypts mailbox and relay credentials while retaining the destination's database credentials", () => {
    const sourceCipher = createEncryption("source-instance-key");
    const targetCipher = createEncryption("different-target-instance-key");
    const source = makeFreshState("source", "example.test");
    source.secrets = {
      VMAIL_DB_BIND_PASSWD: "source-db",
      DOMAIN_ADMIN_PASSWD_PLAIN: "source-postmaster",
    };
    source.dnsAcknowledged = true;
    source.ptrAcknowledged = true;
    source.platformMailbox = {
      email: "openship@example.test",
      password: sourceCipher.encrypt("mail-password"),
      smtpHost: "mail.example.test",
      smtpPort: 587,
      secure: false,
      updatedAt: "2026-01-01",
    };
    source.testMailboxes = { "example.test": { ...source.platformMailbox } };
    source.outboundRelay = {
      enabled: true,
      provider: "custom",
      host: "relay.example.test",
      port: 587,
      username: "sender",
      passwordEncrypted: sourceCipher.encrypt("relay-password"),
      updatedAt: "2026-01-01",
    };
    const target = makeFreshState("destination", "example.test");
    target.secrets = { VMAIL_DB_BIND_PASSWD: "target-db", PGSQL_ROOT_PASSWD: "target-root" };
    target.engineImage = "target-engine";
    const portable = exportMailState(source, sourceCipher);
    const restored = importMailState(portable, target, targetCipher);

    expect(portable.state.platformMailbox?.password).toBe("mail-password");
    expect(JSON.stringify(portable)).not.toContain("source-db");
    expect(targetCipher.decrypt(restored.platformMailbox!.password)).toBe("mail-password");
    expect(targetCipher.decrypt(restored.testMailboxes!["example.test"]!.password)).toBe(
      "mail-password",
    );
    expect(targetCipher.decrypt(restored.outboundRelay!.passwordEncrypted)).toBe("relay-password");
    expect(() => sourceCipher.decrypt(restored.platformMailbox!.password)).toThrow();
    expect(restored.secrets).toEqual({
      VMAIL_DB_BIND_PASSWD: "target-db",
      PGSQL_ROOT_PASSWD: "target-root",
      DOMAIN_ADMIN_PASSWD_PLAIN: "source-postmaster",
    });
    expect(restored.serverId).toBe("destination");
    expect(restored.engineImage).toBe("target-engine");
    expect(restored.dnsAcknowledged).toBe(false);
    expect(restored.ptrAcknowledged).toBe(false);
    expect(sourceCipher.decrypt(source.platformMailbox!.password)).toBe("mail-password");
    sourceCipher.close();
    targetCipher.close();
  });

  it("refuses an undecryptable credential instead of making an unrestorable archive", () => {
    const source = makeFreshState("source", "example.test");
    const wrong = createEncryption("wrong-key");
    const original = createEncryption("original-key");
    source.platformMailbox = {
      email: "openship@example.test",
      password: original.encrypt("secret"),
      smtpHost: "mail.example.test",
      smtpPort: 587,
      secure: false,
      updatedAt: "2026-01-01",
    };
    expect(() => exportMailState(source, wrong)).toThrow();
    original.close();
    wrong.close();
  });

  it("refuses restoring a different primary domain", () => {
    const source = makeFreshState("source", "example.test");
    const target = makeFreshState("target", "unrelated.test");
    expect(() => importMailState(exportMailState(source), target)).toThrow("primary domain");
  });

  it("does not retain a destination password for a postmaster account replaced by the backup", () => {
    const source = makeFreshState("source", "example.test");
    const target = makeFreshState("target", "example.test");
    target.secrets = {
      VMAIL_DB_BIND_PASSWD: "target-db",
      DOMAIN_ADMIN_PASSWD_PLAIN: "old-account-password",
    };
    const restored = importMailState(exportMailState(source), target);
    expect(restored.secrets).toEqual({ VMAIL_DB_BIND_PASSWD: "target-db" });
  });
});
