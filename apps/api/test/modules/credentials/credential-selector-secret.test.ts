import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  credentialRepo: {
    findById: vi.fn(),
    nameTaken: vi.fn(async () => false),
    update: vi.fn(),
  },
  verifyCredentialValues: vi.fn(),
}));

vi.mock("@repo/db", () => ({ repos: { credential: h.credentialRepo } }));
vi.mock("@repo/platform/engine/lib/credential-encryption", () => ({
  encryptSecretField: (value: string) => `enc1:${value}`,
  decryptSecretField: (value: string) => value.replace(/^enc1:/, ""),
}));
vi.mock("@repo/platform/engine/modules/credentials/verify", () => ({
  hasVerifier: () => true,
  verifyCredentialValues: h.verifyCredentialValues,
}));

import { updateCredential } from "@repo/platform/engine/modules/credentials/credential.service";

const stored = (overrides: Record<string, unknown> = {}) => ({
  id: "cred_1",
  organizationId: "org_1",
  provider: "docker-registry",
  name: "Production registry",
  selector: "registry.example.com",
  publicFields: { username: "operator" },
  secretsEnc: `enc1:${JSON.stringify({ secret: "stored-secret" })}`,
  status: "active",
  lastVerifiedAt: new Date("2026-01-01"),
  lastError: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.credentialRepo.findById.mockResolvedValue(stored());
  h.credentialRepo.nameTaken.mockResolvedValue(false);
  h.credentialRepo.update.mockImplementation(
    async (_organizationId: string, _id: string, changes: Record<string, unknown>) =>
      stored(changes),
  );
  h.verifyCredentialValues.mockResolvedValue({ ok: true });
});

describe("credential destination changes", () => {
  it("never forwards a stored secret to a replacement registry", async () => {
    await expect(
      updateCredential("org_1", "cred_1", {
        selector: "capture.attacker.example",
        values: { username: "operator" },
      }),
    ).rejects.toThrow("Password or access token is required");

    expect(h.verifyCredentialValues).not.toHaveBeenCalled();
    expect(h.credentialRepo.update).not.toHaveBeenCalled();
  });

  it("uses only newly submitted secret material for a replacement registry", async () => {
    await updateCredential("org_1", "cred_1", {
      selector: "replacement.example.com",
      values: { username: "operator", secret: "replacement-secret" },
    });

    expect(h.verifyCredentialValues).toHaveBeenCalledWith(
      expect.objectContaining({ id: "docker-registry" }),
      expect.objectContaining({
        selector: "replacement.example.com",
        secrets: { secret: "replacement-secret" },
      }),
    );
    expect(JSON.stringify(h.credentialRepo.update.mock.calls[0]?.[2])).not.toContain(
      "stored-secret",
    );
  });

  it("still permits a blank secret when the normalized registry is unchanged", async () => {
    await updateCredential("org_1", "cred_1", {
      name: "Renamed registry",
      selector: "https://REGISTRY.EXAMPLE.COM/",
      values: { username: "operator" },
    });

    expect(h.verifyCredentialValues).toHaveBeenCalledWith(
      expect.objectContaining({ id: "docker-registry" }),
      expect.objectContaining({
        selector: "registry.example.com",
        secrets: { secret: "stored-secret" },
      }),
    );
  });
});
