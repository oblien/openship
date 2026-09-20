import "./_setup-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readState: vi.fn(),
  mutateState: vi.fn(),
  queryOne: vi.fn(),
  transaction: vi.fn(),
  execute: vi.fn(),
  hashPassword: vi.fn(),
  createMaildirOnDisk: vi.fn(),
  recountDomain: vi.fn(),
  decrypt: vi.fn(),
  encrypt: vi.fn(),
}));

vi.mock("@repo/platform/engine/lib/ssh-manager", () => ({
  sshManager: {
    withExecutor: async (_serverId: string, fn: (exec: object) => unknown) => fn({}),
  },
}));

vi.mock("@repo/platform/engine/lib/encryption", () => ({
  decrypt: mocks.decrypt,
  encrypt: mocks.encrypt,
}));

vi.mock("@repo/platform/engine/modules/mail/mail-state", () => ({
  readState: mocks.readState,
  mutateState: mocks.mutateState,
}));

vi.mock("@repo/platform/engine/modules/mail/admin/psql-runner", () => ({
  execute: mocks.execute,
  queryOne: mocks.queryOne,
  q: (value: string) => `'${value}'`,
  qInt: (value: number) => String(value),
  transaction: mocks.transaction,
}));

vi.mock("@repo/platform/engine/modules/mail/admin/password", () => ({
  hashPassword: mocks.hashPassword,
}));

vi.mock("@repo/platform/engine/modules/mail/admin/maildir", () => ({
  createMaildirOnDisk: mocks.createMaildirOnDisk,
  generateMaildir: (domain: string, localPart: string) => ({
    storagebasedirectory: "/var/vmail",
    storagenode: "vmail1",
    maildir: `${domain}/${localPart}/`,
  }),
  removeMaildirOnDisk: vi.fn(),
  STORAGE_BASE: "/var/vmail",
  STORAGE_NODE: "vmail1",
}));

vi.mock("@repo/platform/engine/modules/mail/admin/domains.service", () => ({
  recountDomain: mocks.recountDomain,
}));

import { ensureOpenshipPlatformMailbox } from "@repo/platform/engine/modules/mail/admin/platform-mailbox.service";

const state = {
  domain: "example.com",
  platformMailbox: {
    email: "openship@example.com",
    password: "sealed-old-password",
    smtpHost: "mail.example.com",
    smtpPort: 465,
    secure: true,
    updatedAt: "2026-08-01T00:00:00.000Z",
  },
};

describe("ensureOpenshipPlatformMailbox live reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readState.mockResolvedValue(state);
    mocks.decrypt.mockReturnValue("old-plaintext");
    mocks.encrypt.mockReturnValue("sealed-new-password");
    mocks.hashPassword.mockResolvedValue("{SSHA512}new-hash");
    mocks.transaction.mockResolvedValue(undefined);
    mocks.createMaildirOnDisk.mockResolvedValue(undefined);
    mocks.mutateState.mockResolvedValue(undefined);
    mocks.recountDomain.mockResolvedValue(undefined);
  });

  it("reuses cached credentials only when both required vmail rows are active", async () => {
    mocks.queryOne.mockResolvedValue({
      mailboxActive: true,
      forwardingActive: true,
    });

    const result = await ensureOpenshipPlatformMailbox("srv_mail");

    expect(result).toMatchObject({
      email: "openship@example.com",
      password: "old-plaintext",
      rotated: false,
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.mutateState).not.toHaveBeenCalled();
  });

  it.each([
    { mailboxActive: false, forwardingActive: true },
    { mailboxActive: true, forwardingActive: false },
    { mailboxActive: false, forwardingActive: false },
  ])("recreates stale cached state for $mailboxActive/$forwardingActive", async (live) => {
    mocks.queryOne.mockResolvedValue(live);

    const result = await ensureOpenshipPlatformMailbox("srv_mail");

    expect(result.rotated).toBe(true);
    expect(mocks.hashPassword).toHaveBeenCalledOnce();
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.mutateState).toHaveBeenCalledOnce();
  });

  it("forced rotation bypasses the live-row fast-path lookup", async () => {
    const result = await ensureOpenshipPlatformMailbox("srv_mail", {
      rotate: true,
    });

    expect(result.rotated).toBe(true);
    expect(mocks.queryOne).not.toHaveBeenCalled();
    expect(mocks.transaction).toHaveBeenCalledOnce();
  });
});
