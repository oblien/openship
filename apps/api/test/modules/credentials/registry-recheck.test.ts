import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  credential: { findActive: vi.fn(), findById: vi.fn(), recordVerification: vi.fn() },
  verify: vi.fn(),
  providerAccess: vi.fn(),
}));
vi.mock("@repo/db", () => ({ repos: { credential: h.credential } }));
vi.mock("@repo/platform/engine/lib/provision-lock", () => ({
  createProvisionLock: () => ({ run: (work: () => Promise<unknown>) => work() }),
}));
vi.mock("@repo/platform/engine/lib/credential-encryption", () => ({
  encryptSecretField: (value: string) => value,
  decryptSecretField: (value: string) => value,
}));
vi.mock("@repo/platform/engine/modules/credentials/verify", () => ({
  hasVerifier: () => true,
  verifyCredentialValues: h.verify,
}));
vi.mock("@repo/platform/engine/modules/credentials/connection-authorization", () => ({
  getProviderAccess: h.providerAccess,
}));
import {
  recheckRejectedRegistryCredential,
  verifyCredential,
} from "@repo/platform/engine/modules/credentials/credential.service";

const row = {
  id: "credential-a",
  organizationId: "org-a",
  provider: "docker-registry",
  name: "Production GHCR",
  selector: "ghcr.io",
  publicFields: { username: "owner" },
  secretsEnc: JSON.stringify({ secret: "old-secret" }),
  status: "active",
  lastVerifiedAt: new Date("2026-10-01"),
  lastError: null,
  createdAt: new Date("2026-10-01"),
  updatedAt: new Date("2026-10-01"),
};
beforeEach(() => {
  vi.resetAllMocks();
  h.credential.findActive.mockResolvedValue(row);
  h.credential.findById.mockResolvedValue(row);
});

describe("rechecking a registry after an image access denial", () => {
  it("records a rejected login only against the exact credential checked in the owning org", async () => {
    const verdict = {
      ok: false,
      credentialRejected: true,
      reason: "ghcr.io rejected these credentials.",
    };
    h.verify.mockResolvedValue(verdict);
    await recheckRejectedRegistryCredential("org-a", "https://GHCR.IO/");
    expect(h.credential.findActive).toHaveBeenCalledWith("org-a", "docker-registry", "ghcr.io");
    expect(h.verify).toHaveBeenCalledWith(expect.objectContaining({ id: "docker-registry" }), {
      selector: "ghcr.io",
      publicFields: { username: "owner" },
      secrets: { secret: "old-secret" },
    });
    expect(h.credential.recordVerification).toHaveBeenCalledWith(row, verdict);
  });

  it("keeps a valid login active when one package denies access", async () => {
    h.verify.mockResolvedValue({ ok: true });
    await recheckRejectedRegistryCredential("org-a", "ghcr.io");
    expect(h.credential.recordVerification).toHaveBeenCalledWith(row, { ok: true });
  });

  it.each(["timed out", "TLS failed", "answered 429", "answered 503"])(
    "does not invalidate credentials when the check %s",
    async (reason) => {
      h.verify.mockResolvedValue({ ok: false, reason });
      await recheckRejectedRegistryCredential("org-a", "ghcr.io");
      expect(h.credential.recordVerification).not.toHaveBeenCalled();
    },
  );

  it("leaves the saved status and date alone when the registry allows anonymous access", async () => {
    h.verify.mockResolvedValue({ ok: true, unverifiedReason: "Registry allows anonymous access." });
    await recheckRejectedRegistryCredential("org-a", "ghcr.io");
    await expect(verifyCredential("org-a", row.id)).rejects.toThrow(
      "Registry allows anonymous access.",
    );
    expect(h.credential.recordVerification).not.toHaveBeenCalled();
  });

  it("reports a manual registry outage without disabling the login", async () => {
    h.verify.mockResolvedValue({ ok: false, reason: "Registry unavailable." });
    await expect(verifyCredential("org-a", row.id)).rejects.toThrow("Registry unavailable.");
    expect(h.credential.recordVerification).not.toHaveBeenCalled();
  });

  it("does not look up another organization's credentials or probe an unsaved registry", async () => {
    h.credential.findActive.mockResolvedValue(undefined);
    await recheckRejectedRegistryCredential("org-b", "ghcr.io");
    expect(h.credential.findActive).toHaveBeenCalledExactlyOnceWith(
      "org-b",
      "docker-registry",
      "ghcr.io",
    );
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.credential.recordVerification).not.toHaveBeenCalled();
  });

  it("manual verification returns the replacement row when credentials rotate during a check", async () => {
    h.verify.mockImplementation(async () => {
      h.credential.findById.mockResolvedValue({
        ...row,
        secretsEnc: JSON.stringify({ secret: "new-secret" }),
      });
      return { ok: false, credentialRejected: true };
    });
    const result = await verifyCredential("org-a", row.id);
    expect(h.credential.recordVerification).toHaveBeenCalledWith(row, {
      ok: false,
      credentialRejected: true,
    });
    expect(result.status).toBe("active");
    expect(JSON.stringify(result)).not.toMatch(/old-secret|new-secret/);
  });

  it("records manual verification against the refreshed OAuth token", async () => {
    const before = {
      ...row,
      provider: "railway",
      selector: null,
      publicFields: { authorization: "oauth" },
      secretsEnc: JSON.stringify({ apiToken: "expired-token" }),
      status: "invalid",
    };
    const refreshed = { ...before, secretsEnc: JSON.stringify({ apiToken: "refreshed-token" }) };
    h.credential.findById.mockResolvedValueOnce(before).mockResolvedValue(refreshed);
    h.verify.mockResolvedValue({ ok: true });

    await verifyCredential("org-a", row.id);

    expect(h.providerAccess).toHaveBeenCalledWith("org-a", row.id, { allowInvalid: true });
    expect(h.verify).toHaveBeenCalledWith(expect.objectContaining({ id: "railway" }), {
      selector: null,
      publicFields: { authorization: "oauth" },
      secrets: { apiToken: "refreshed-token" },
    });
    expect(h.credential.recordVerification).toHaveBeenCalledWith(refreshed, { ok: true });
  });
});
