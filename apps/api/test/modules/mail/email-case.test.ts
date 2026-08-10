import "./_setup-env";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  queryOne: vi.fn(),
  transaction: vi.fn(),
  readState: vi.fn(),
  removeMaildirOnDisk: vi.fn(),
  recountDomain: vi.fn(),
}));

vi.mock("../../../src/lib/ssh-manager", () => ({
  sshManager: {
    withExecutor: async (_serverId: string, fn: (exec: object) => unknown) => fn({}),
  },
}));

vi.mock("../../../src/modules/mail/admin/psql-runner", () => ({
  execute: mocks.execute,
  queryOne: mocks.queryOne,
  queryRows: vi.fn(),
  q: (value: string) => `'${value}'`,
  qInt: (value: number) => String(value),
  transaction: mocks.transaction,
}));

vi.mock("../../../src/modules/mail/mail-state", () => ({
  readState: mocks.readState,
}));

vi.mock("../../../src/modules/mail/admin/maildir", () => ({
  createMaildirOnDisk: vi.fn(),
  generateMaildir: vi.fn(),
  removeMaildirOnDisk: mocks.removeMaildirOnDisk,
  STORAGE_BASE: "/var/vmail",
  STORAGE_NODE: "vmail1",
}));

vi.mock("../../../src/modules/mail/admin/domains.service", () => ({
  recountDomain: mocks.recountDomain,
  validateDomain: vi.fn(),
}));

vi.mock("../../../src/modules/mail/admin/password", () => ({
  hashPassword: vi.fn(),
}));

vi.mock("../../../src/modules/mail/admin/platform-mailbox.service", () => ({
  buildInsertMailboxSql: vi.fn(),
  buildInsertSelfForwardingSql: vi.fn(),
}));

import { createAlias } from "../../../src/modules/mail/admin/aliases.service";
import {
  getMailbox,
  hardDeleteMailbox,
  softDeleteMailbox,
  updateMailbox,
} from "../../../src/modules/mail/admin/mailboxes.service";

const INVALID_EMAILS = [
  "not-an-email",
  "ops@example",
  "ops @example.com",
  "@example.com",
  `${"a".repeat(250)}@example.com`,
];

function alias(address: string, forwarding: string) {
  return {
    id: 1,
    address,
    forwarding,
    domain: "example.com",
    destDomain: forwarding.split("@")[1],
    isCatchAll: false,
    active: true,
  };
}

function mailbox(username: string) {
  return {
    username,
    name: "Ops",
    domain: "example.com",
    quotaMB: 0,
    storagebasedirectory: "/var/vmail",
    storagenode: "vmail1",
    maildir: "example.com/o/p/s/ops-2026.07.31.00.00.00/",
    active: true,
    isAdmin: false,
    isGlobalAdmin: false,
    createdAt: "2026-07-31",
    passwordLastChange: "2026-07-31",
  };
}

function sqlOf(calls: unknown[][]): string {
  return calls.map((args) => String(args[1])).join("\n");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.execute.mockResolvedValue(undefined);
  mocks.transaction.mockResolvedValue(undefined);
  mocks.recountDomain.mockResolvedValue(undefined);
  mocks.removeMaildirOnDisk.mockResolvedValue(undefined);
  mocks.readState.mockResolvedValue({ domain: "primary.example" });
});

describe("createAlias destination", () => {
  beforeEach(() => {
    mocks.queryOne.mockImplementation(async (_serverId: string, sql: string) =>
      sql.includes("is_alias = 1") ? alias("sales@example.com", "ops@example.com") : null,
    );
  });

  test("accepts a mixed-case destination and stores it lowercased", async () => {
    const row = await createAlias("srv_test", {
      domain: "example.com",
      localPart: "sales",
      isCatchAll: false,
      destination: "Ops@Example.com",
    });

    expect(row.forwarding).toBe("ops@example.com");
    expect(sqlOf(mocks.execute.mock.calls)).toContain("'ops@example.com'");
    expect(sqlOf(mocks.execute.mock.calls)).not.toContain("Ops@Example.com");
  });

  test("accepts a destination whose domain part alone is mixed-case", async () => {
    await expect(
      createAlias("srv_test", {
        domain: "example.com",
        localPart: "sales",
        isCatchAll: false,
        destination: "ops@Example.COM",
      }),
    ).resolves.toMatchObject({ forwarding: "ops@example.com" });
  });

  test("accepts a whitespace-padded destination", async () => {
    await createAlias("srv_test", {
      domain: "example.com",
      localPart: "sales",
      isCatchAll: false,
      destination: "  ops@example.com  ",
    });

    expect(sqlOf(mocks.execute.mock.calls)).toContain("'ops@example.com'");
  });

  test.each(INVALID_EMAILS)("still rejects the destination %j", async (destination) => {
    await expect(
      createAlias("srv_test", {
        domain: "example.com",
        localPart: "sales",
        isCatchAll: false,
        destination,
      }),
    ).rejects.toThrow(/^Invalid email:/);

    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

describe("mailbox lookup by address", () => {
  beforeEach(() => {
    mocks.queryOne.mockResolvedValue(mailbox("ops@example.com"));
  });

  test("getMailbox accepts a mixed-case address and queries the lowercased username", async () => {
    await expect(getMailbox("srv_test", "Ops@Example.com")).resolves.toMatchObject({
      username: "ops@example.com",
    });

    expect(sqlOf(mocks.queryOne.mock.calls)).toContain("username = 'ops@example.com'");
  });

  test("getMailbox accepts an address whose domain part alone is mixed-case", async () => {
    await expect(getMailbox("srv_test", "ops@Example.COM")).resolves.toMatchObject({
      username: "ops@example.com",
    });

    expect(sqlOf(mocks.queryOne.mock.calls)).toContain("username = 'ops@example.com'");
  });

  test("getMailbox accepts a whitespace-padded address", async () => {
    await expect(getMailbox("srv_test", "  ops@example.com  ")).resolves.toMatchObject({
      username: "ops@example.com",
    });
  });

  test("updateMailbox accepts a mixed-case address", async () => {
    await updateMailbox("srv_test", "Ops@Example.com", { active: false });

    expect(sqlOf(mocks.execute.mock.calls)).toContain("username = 'ops@example.com'");
  });

  test("softDeleteMailbox accepts a mixed-case address", async () => {
    await softDeleteMailbox("srv_test", "Ops@Example.com", "admin@example.com");

    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(String(mocks.transaction.mock.calls[0]![1])).toContain("'ops@example.com'");
  });

  test("hardDeleteMailbox accepts a mixed-case address", async () => {
    await hardDeleteMailbox("srv_test", "Ops@Example.com");

    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(String(mocks.transaction.mock.calls[0]![1])).toContain("'ops@example.com'");
  });

  test.each(INVALID_EMAILS)("getMailbox still rejects %j", async (email) => {
    await expect(getMailbox("srv_test", email)).rejects.toThrow(/^Invalid email:/);
    expect(mocks.queryOne).not.toHaveBeenCalled();
  });

  test.each(INVALID_EMAILS)("hardDeleteMailbox still rejects %j", async (email) => {
    await expect(hardDeleteMailbox("srv_test", email)).rejects.toThrow(/^Invalid email:/);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
