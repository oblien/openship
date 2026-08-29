import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #581: a private-image pull went out anonymous because dockerode reads no
 * `~/.docker/config.json`. It now asks Openship's own credential store — and the two
 * properties that matter are that the lookup keys off the SAME registry derivation the
 * credential was saved under, and that a failure degrades to an anonymous pull instead of
 * failing the deploy.
 */

const { findActive } = vi.hoisted(() => ({ findActive: vi.fn() }));

vi.mock("@repo/db", () => ({
  repos: { credential: { findActive } },
}));

// The service reads the encrypted envelope; keep the real crypto out of a unit test by
// mocking only the two functions it uses.
vi.mock("../../../src/lib/credential-encryption", () => ({
  encryptSecretField: (s: string) => `enc1:${s}`,
  decryptSecretField: (s: string | null | undefined) =>
    s && s.startsWith("enc1:") ? s.slice(5) : (s ?? undefined),
  isEncryptedSecret: (s: string) => s?.startsWith("enc1:"),
}));

import { resolveRegistryAuthFor, registryAuthResolver } from "../../../src/modules/credentials/registry-auth";

const ORG = "org_1";

/** A stored docker-registry credential row, as the repo would return it. */
const row = (selector: string, username = "bob", secret = "pat_123") => ({
  id: "cred_1",
  organizationId: ORG,
  provider: "docker-registry",
  name: "test",
  selector,
  publicFields: { username },
  secretsEnc: `enc1:${JSON.stringify({ secret })}`,
  status: "active",
});

beforeEach(() => {
  vi.clearAllMocks();
  findActive.mockResolvedValue(undefined);
});

describe("resolveRegistryAuthFor", () => {
  it("looks the credential up under the registry the IMAGE addresses", async () => {
    findActive.mockResolvedValue(row("ghcr.io"));
    const auth = await resolveRegistryAuthFor({ organizationId: ORG, ref: "ghcr.io/o/img:1" });
    expect(findActive).toHaveBeenCalledWith(ORG, "docker-registry", "ghcr.io");
    expect(auth).toEqual({ username: "bob", password: "pat_123", serveraddress: "ghcr.io" });
  });

  it("derives docker.io for a bare tagged image, not the tag", async () => {
    // The #581 parse bug in another form: a credential saved for Docker Hub must be found
    // for `postgres:16-alpine`, whose colon is a tag, not a registry port.
    findActive.mockResolvedValue(row("docker.io"));
    await resolveRegistryAuthFor({ organizationId: ORG, ref: "postgres:16-alpine" });
    expect(findActive).toHaveBeenCalledWith(ORG, "docker-registry", "docker.io");
  });

  it("sends serveraddress equal to the looked-up registry", async () => {
    // Docker picks the credential for the manifest host by this field and ignores a
    // mismatch silently, so it must be the normalized value, not the raw reference.
    findActive.mockResolvedValue(row("registry.example.com:5000"));
    const auth = await resolveRegistryAuthFor({
      organizationId: ORG,
      ref: "registry.example.com:5000/o/img",
    });
    expect(auth?.serveraddress).toBe("registry.example.com:5000");
  });

  it("pulls anonymously when the org has no credential for that registry", async () => {
    expect(await resolveRegistryAuthFor({ organizationId: ORG, ref: "ghcr.io/o/i" })).toBeUndefined();
  });

  it("pulls anonymously when the stored envelope is empty", async () => {
    // The cross-instance restore case: the row survived, its secret could not.
    findActive.mockResolvedValue({ ...row("ghcr.io"), secretsEnc: "" });
    expect(await resolveRegistryAuthFor({ organizationId: ORG, ref: "ghcr.io/o/i" })).toBeUndefined();
  });

  it("pulls anonymously when the row is missing half the pair", async () => {
    // Basic auth needs both. Sending a half-credential makes the registry answer 401,
    // which reads to the operator as "wrong password" rather than "incomplete record".
    findActive.mockResolvedValue({ ...row("ghcr.io"), publicFields: {} });
    expect(await resolveRegistryAuthFor({ organizationId: ORG, ref: "ghcr.io/o/i" })).toBeUndefined();

    findActive.mockResolvedValue({ ...row("ghcr.io"), secretsEnc: `enc1:${JSON.stringify({})}` });
    expect(await resolveRegistryAuthFor({ organizationId: ORG, ref: "ghcr.io/o/i" })).toBeUndefined();
  });

  it("does not fail the pull when the lookup throws", async () => {
    // A credential lookup must never be the reason a deploy dies: anonymous is the right
    // degradation, and a genuinely private image then fails with the registry's own 401.
    findActive.mockRejectedValue(new Error("db down"));
    await expect(
      resolveRegistryAuthFor({ organizationId: ORG, ref: "ghcr.io/o/i" }),
    ).resolves.toBeUndefined();
  });
});

describe("registryAuthResolver", () => {
  it("binds the organization so a runtime cannot resolve another tenant's login", async () => {
    findActive.mockResolvedValue(row("ghcr.io"));
    const resolve = registryAuthResolver("org_bound");
    await resolve("ghcr.io/o/i");
    expect(findActive).toHaveBeenCalledWith("org_bound", "docker-registry", "ghcr.io");
  });
});
