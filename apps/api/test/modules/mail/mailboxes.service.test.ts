import "./_setup-env";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryOne: vi.fn(),
  queryRows: vi.fn(),
  execute: vi.fn(),
  transaction: vi.fn(),
  readState: vi.fn(),
  removeMaildirOnDisk: vi.fn(),
  recountDomain: vi.fn(),
}));

vi.mock("@repo/platform/engine/lib/ssh-manager", () => ({
  sshManager: {
    withExecutor: async (_serverId: string, fn: (exec: object) => unknown) => fn({}),
  },
}));

vi.mock("@repo/platform/engine/modules/mail/admin/psql-runner", () => ({
  execute: mocks.execute,
  queryOne: mocks.queryOne,
  queryRows: mocks.queryRows,
  q: (value: string) => `'${value}'`,
  qInt: (value: number) => String(value),
  transaction: mocks.transaction,
}));

vi.mock("@repo/platform/engine/modules/mail/mail-state", () => ({
  readState: mocks.readState,
}));

vi.mock("@repo/platform/engine/modules/mail/admin/maildir", () => ({
  createMaildirOnDisk: vi.fn(),
  generateMaildir: vi.fn(),
  removeMaildirOnDisk: mocks.removeMaildirOnDisk,
  STORAGE_BASE: "/var/vmail",
  STORAGE_NODE: "vmail1",
}));

vi.mock("@repo/platform/engine/modules/mail/admin/domains.service", () => ({
  recountDomain: mocks.recountDomain,
  validateDomain: vi.fn(),
}));

vi.mock("@repo/platform/engine/modules/mail/admin/password", () => ({
  hashPassword: vi.fn(),
}));

vi.mock("@repo/platform/engine/modules/mail/admin/platform-mailbox.service", () => ({
  buildInsertMailboxSql: vi.fn(),
  buildInsertSelfForwardingSql: vi.fn(),
  PLATFORM_LOCAL_PART: "openship",
}));

import {
  createMailbox,
  hardDeleteMailbox,
  listMailboxes,
  PlatformMailboxProtectedError,
  softDeleteMailbox,
  updateMailbox,
} from "@repo/platform/engine/modules/mail/admin/mailboxes.service";

function mailbox(username: string, domain: string) {
  return {
    username,
    name: "Postmaster",
    domain,
    quotaMB: 0,
    storagebasedirectory: "/var/vmail",
    storagenode: "vmail1",
    maildir: `${domain}/p/o/s/postmaster-2026.07.21.00.00.00/`,
    active: true,
    isAdmin: false,
    isGlobalAdmin: false,
    createdAt: "2026-07-21",
    passwordLastChange: "2026-07-21",
  };
}

describe("hardDeleteMailbox postmaster protection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readState.mockResolvedValue({ domain: "primary.example" });
    mocks.transaction.mockResolvedValue(undefined);
    mocks.removeMaildirOnDisk.mockResolvedValue(undefined);
    mocks.recountDomain.mockResolvedValue(undefined);
  });

  test("allows hard-deleting the postmaster mailbox of an additional domain", async () => {
    mocks.queryOne.mockResolvedValue(
      mailbox("postmaster@additional.example", "additional.example"),
    );

    await hardDeleteMailbox("srv_test", "postmaster@additional.example");

    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.removeMaildirOnDisk).toHaveBeenCalledOnce();
    expect(mocks.recountDomain).toHaveBeenCalledWith("srv_test", "additional.example");
  });

  test("refuses to hard-delete the postmaster mailbox of the install domain", async () => {
    mocks.queryOne.mockResolvedValue(mailbox("postmaster@primary.example", "primary.example"));

    await expect(hardDeleteMailbox("srv_test", "postmaster@primary.example")).rejects.toThrow(
      /refusing to hard-delete the postmaster mailbox/i,
    );

    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  test("refuses to hard-delete a postmaster mailbox when install state is unavailable", async () => {
    mocks.queryOne.mockResolvedValue(
      mailbox("postmaster@additional.example", "additional.example"),
    );
    mocks.readState.mockResolvedValue(null);

    await expect(hardDeleteMailbox("srv_test", "postmaster@additional.example")).rejects.toThrow(
      /refusing to hard-delete the postmaster mailbox/i,
    );

    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

describe("platform mailbox protection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readState.mockResolvedValue({ domain: "primary.example" });
    mocks.transaction.mockResolvedValue(undefined);
  });

  test("marks only the primary install sender as platform-owned", async () => {
    mocks.queryRows.mockResolvedValue([
      mailbox("openship@primary.example", "primary.example"),
      mailbox("alice@primary.example", "primary.example"),
    ]);

    const rows = await listMailboxes("srv_test", "primary.example");

    expect(rows.map(({ username, isPlatform }) => ({ username, isPlatform }))).toEqual([
      { username: "openship@primary.example", isPlatform: true },
      { username: "alice@primary.example", isPlatform: false },
    ]);
  });

  test("fails closed for the reserved sender when install state is unreadable", async () => {
    mocks.readState.mockResolvedValue(null);
    mocks.queryOne.mockResolvedValue(mailbox("openship@primary.example", "primary.example"));

    await expect(hardDeleteMailbox("srv_test", "openship@primary.example")).rejects.toBeInstanceOf(
      PlatformMailboxProtectedError,
    );
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  test("does not let ordinary create claim the reserved sender while state is unreadable", async () => {
    mocks.readState.mockResolvedValue(null);
    mocks.queryOne.mockResolvedValue(null);

    await expect(
      createMailbox("srv_test", {
        localPart: "openship",
        domain: "primary.example",
        password: "long-enough-password",
      }),
    ).rejects.toBeInstanceOf(PlatformMailboxProtectedError);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  test.each([
    ["update", () => updateMailbox("srv_test", "openship@primary.example", { active: false })],
    [
      "soft delete",
      () => softDeleteMailbox("srv_test", "openship@primary.example", "admin@example.com"),
    ],
    ["hard delete", () => hardDeleteMailbox("srv_test", "openship@primary.example")],
  ])("refuses ordinary %s operations", async (_operation, run) => {
    mocks.queryOne.mockResolvedValue(mailbox("openship@primary.example", "primary.example"));

    await expect(run()).rejects.toBeInstanceOf(PlatformMailboxProtectedError);

    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
