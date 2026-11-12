import "./_setup-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  existing: null as unknown,
  destinationOrg: "org",
  saved: vi.fn(),
  flavor: vi.fn(),
}));
vi.mock("@repo/db", async (original) => ({
  ...(await original<typeof import("@repo/db")>()),
  repos: {
    mailServer: { get: async () => ({ domain: "example.test" }) },
    backupDestination: { findById: async () => ({ organizationId: mocks.destinationOrg }) },
    backupPolicy: {
      findActiveByMailServer: async () => mocks.existing,
      create: async (data: unknown) => {
        mocks.saved(data);
        return data;
      },
      update: async (_id: string, data: unknown) => {
        mocks.saved(data);
        return data;
      },
    },
  },
}));
vi.mock("../../../src/lib/permission", () => ({ permission: { assert: async () => {} } }));
vi.mock("@repo/platform/engine/lib/resource-access", () => ({ isServerInOrg: async () => true }));
vi.mock("../../../src/lib/request-context", () => ({
  getRequestContext: () => ({ userId: "owner", organizationId: "org" }),
}));
vi.mock("@repo/platform/engine/modules/backups/triggers/cron", () => ({
  syncPolicySchedule: async () => {},
  validateCronExpression: () => ({ valid: true }),
}));
vi.mock("@repo/platform/engine/modules/mail/mail-engine", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/modules/mail/mail-engine")>()),
  resolveMailFlavor: mocks.flavor,
}));
import { saveMailBackupPolicy } from "../../../src/modules/mail/mail.controller";
async function save(body: Record<string, unknown>) {
  const json = vi.fn((body: unknown, status = 200) => ({ body, status }));
  const ctx = {
    req: {
      param: () => "mail-server",
      json: async () => ({ destinationId: "destination", ...body }),
    },
    json,
  };
  return (await saveMailBackupPolicy(ctx as never)) as unknown as { body: unknown; status: number };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.existing = null;
  mocks.destinationOrg = "org";
  mocks.flavor.mockResolvedValue("host");
});
describe("mail backup policy defaults and scope", () => {
  it("includes messages and keys in a new policy", async () => {
    expect((await save({})).status).toBe(200);
    expect(mocks.saved.mock.calls[0]![0].payloadConfig.mail).toEqual({
      messageData: true,
      keys: true,
    });
  });
  it("retains explicit exclusions on an existing policy", async () => {
    mocks.existing = { id: "policy", payloadConfig: { mail: { messageData: false, keys: false } } };
    expect((await save({})).status).toBe(200);
    expect(mocks.saved.mock.calls[0]![0].payloadConfig.mail).toEqual({
      messageData: false,
      keys: false,
    });
  });
  it("can explicitly upgrade an old policy to a full backup", async () => {
    mocks.existing = { id: "policy", payloadConfig: { mail: { messageData: false, keys: false } } };
    expect((await save({ messageData: true, keys: true })).status).toBe(200);
    expect(mocks.saved.mock.calls[0]![0].payloadConfig.mail.messageData).toBe(true);
  });
  it("rejects a foreign destination before touching the mail host", async () => {
    mocks.destinationOrg = "foreign";
    expect((await save({})).status).toBe(404);
    expect(mocks.flavor).not.toHaveBeenCalled();
    expect(mocks.saved).not.toHaveBeenCalled();
  });
  it("rejects ambiguous non-boolean capture flags", async () => {
    expect((await save({ messageData: "false" })).status).toBe(400);
    expect(mocks.saved).not.toHaveBeenCalled();
  });
});
