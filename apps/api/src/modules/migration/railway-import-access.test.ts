import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderService } from "@repo/platform/engine/modules/migration/providers/types";
const h = vi.hoisted(() => ({
  query: vi.fn(),
  access: vi.fn(),
  find: vi.fn(),
  update: vi.fn(),
  verify: vi.fn(),
  config: vi.fn(),
  executor: vi.fn(),
}));
vi.mock("@repo/db", () => ({
  repos: { dockerMigrationRun: { findById: h.find, updateRecovery: h.update } },
}));
vi.mock("@repo/platform/engine/modules/credentials/provider-api", () => ({
  railwayQuery: h.query,
}));
vi.mock("@repo/platform/engine/modules/credentials/connection-authorization", () => ({
  getProviderAccess: h.access,
}));
vi.mock("@repo/platform/engine/lib/encryption", () => ({
  encrypt: (s: string) => Buffer.from(s).toString("base64"),
  decrypt: (s: string) => Buffer.from(s, "base64").toString(),
}));
vi.mock("@repo/platform/engine/lib/ssh-manager", () => ({ buildSshConfig: h.config }));
vi.mock("@repo/platform/engine/lib/customer-ssh", () => ({
  verifyCustomerSshConnection: h.verify,
}));
vi.mock("@repo/adapters", async (original) => ({
  ...(await original<object>()),
  createExecutor: h.executor,
}));
import {
  openRailwayDataSource,
  revokeRailwayImportKey,
} from "@repo/platform/engine/modules/migration/providers/railway-data";
let row: any;
const page = (values: unknown[], cursor?: string) => ({
  edges: values.map((node) => ({ node })),
  pageInfo: { hasNextPage: !!cursor, endCursor: cursor ?? null },
});
const service = {
  id: "service",
  instanceId: "instance",
  volumes: [{ mountPath: "/data" }],
} as ProviderService;
beforeEach(() => {
  vi.resetAllMocks();
  row = {
    organizationId: "org",
    recovery: { providerImport: { connectionId: "connection", projects: {}, completed: [] } },
  };
  h.find.mockImplementation(async () => structuredClone(row));
  h.update.mockImplementation(async (_id, patch) => {
    Object.assign(row.recovery, patch);
  });
  h.access.mockResolvedValue({
    provider: "railway",
    publicFields: { workspaceId: "workspace" },
    secrets: { apiToken: "test-token" },
  });
  h.verify.mockResolvedValue({ hostKey: "pinned-host-key" });
  h.config.mockResolvedValue({ host: "ssh.railway.com" });
  h.executor.mockReturnValue({ dispose: vi.fn() });
});
describe("temporary Railway data access", () => {
  it("records encrypted grant intent before registration, then persists the key ID and host pin", async () => {
    h.query.mockImplementation(async (_access, query, variables) => {
      expect(query).toContain("sshPublicKeyCreate");
      expect(row.recovery.providerImport.sshPrivateKeyEnc).not.toContain("PRIVATE KEY");
      expect(row.recovery.providerImport.sshPublicKey).toBe(variables.input.publicKey);
      return { sshPublicKeyCreate: { id: "grant" } };
    });
    await openRailwayDataSource("run", service, new AbortController().signal);
    expect(row.recovery.providerImport).toMatchObject({
      sshKeyId: "grant",
      sshHostKey: "pinned-host-key",
    });
    expect(h.verify).toHaveBeenCalledWith(
      expect.objectContaining({ sshHost: "ssh.railway.com", sshUser: "instance", sshPort: 22 }),
      "migration_source",
      undefined,
    );
  });
  it("keeps an ambiguous grant recoverable and refuses to register a second key", async () => {
    h.query.mockRejectedValue(new Error("response lost"));
    await expect(
      openRailwayDataSource("run", service, new AbortController().signal),
    ).rejects.toThrow("response lost");
    expect(row.recovery.providerImport.sshPrivateKeyEnc).toBeTruthy();
    await expect(
      openRailwayDataSource("run", service, new AbortController().signal),
    ).rejects.toMatchObject({ code: "IMPORT_SSH_CLEANUP_REQUIRED" });
    expect(h.query).toHaveBeenCalledTimes(1);
  });
  it("finds an ambiguously registered key across pages by its bytes and removes only that key", async () => {
    Object.assign(row.recovery.providerImport, {
      sshPrivateKeyEnc: "encrypted-key",
      sshPublicKey: "ssh-ed25519 AAAA owned-comment",
      sshKeyRequestedAt: Date.now() - 61_000,
    });
    h.query.mockImplementation(async (_access, query: string, variables) => {
      if (query.includes("sshPublicKeyDelete")) {
        expect(variables.id).toBe("ours");
        return { sshPublicKeyDelete: true };
      }
      return {
        sshPublicKeys: variables.after
          ? page([{ id: "ours", publicKey: "ssh-ed25519 AAAA normalized-comment" }])
          : page([{ id: "customer", publicKey: "ssh-ed25519 BBBB owned-comment" }], "page-2"),
      };
    });
    await revokeRailwayImportKey("run");
    expect(h.query).toHaveBeenCalledTimes(3);
    expect(row.recovery.providerImport).not.toHaveProperty("sshPrivateKeyEnc");
  });
  it("does not clear cleanup state when revocation fails", async () => {
    Object.assign(row.recovery.providerImport, {
      sshPrivateKeyEnc: "encrypted-key",
      sshKeyId: "ours",
    });
    h.query.mockResolvedValue({ sshPublicKeyDelete: false });
    await expect(revokeRailwayImportKey("run")).rejects.toMatchObject({
      code: "IMPORT_SSH_CLEANUP_REQUIRED",
    });
    expect(row.recovery.providerImport.sshKeyId).toBe("ours");
  });
});
