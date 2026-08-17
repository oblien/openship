import { describe, expect, it } from "vitest";

import type { CredentialProvider } from "./credentials";
import {
  CREDENTIAL_MASK,
  CREDENTIAL_PROVIDERS as NARROWED,
  credentialProvidersFor,
  getCredentialProvider,
  normalizeCredentialSelector,
  splitCredentialValues,
  validateCredentialValues,
} from "./credentials";

/**
 * The registry is what lets one table and one settings screen serve every provider, so
 * the invariants worth pinning are the ones a NEW provider entry could break silently:
 * the storage split following the field declarations, secrets never landing in the
 * readable column, and a selector normalizing to the same key a consumer looks up.
 */

/**
 * Widened to the interface on purpose. `CREDENTIAL_PROVIDERS` is declared
 * `as const satisfies`, which narrows field types so tightly that a `select` field is
 * statically impossible today — TypeScript then rejects the guard below as unreachable.
 * These are invariants for whatever a FUTURE entry declares, so they are asserted against
 * the contract, not against the current literals.
 */
const CREDENTIAL_PROVIDERS = NARROWED as readonly CredentialProvider[];

const registry = getCredentialProvider("docker-registry")!;
const cloudflare = getCredentialProvider("cloudflare")!;

describe("the provider catalogue", () => {
  it("declares a unique id per provider", () => {
    const ids = CREDENTIAL_PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every provider at least one secret field", () => {
    // A "credential" with nothing secret is configuration, and belongs elsewhere.
    for (const p of CREDENTIAL_PROVIDERS) {
      expect(p.fields.some((f) => f.type === "secret"), p.id).toBe(true);
    }
  });

  it("declares unique field keys within a provider", () => {
    // Two fields sharing a key would silently overwrite each other in the split below.
    for (const p of CREDENTIAL_PROVIDERS) {
      const keys = p.fields.map((f) => f.key);
      expect(new Set(keys).size, p.id).toBe(keys.length);
    }
  });

  it("gives every select field a non-empty option list", () => {
    for (const p of CREDENTIAL_PROVIDERS) {
      for (const f of p.fields) {
        if (f.type === "select") expect(f.options?.length ?? 0, `${p.id}.${f.key}`).toBeGreaterThan(0);
      }
    }
  });

  it("gives every provider a logo slug, not a URL", () => {
    // A URL here would put a CDN literal per provider in core; the dashboard builds it
    // from the same devicon base STACK_ICONS uses.
    for (const p of CREDENTIAL_PROVIDERS) {
      expect(p.icon, p.id).toMatch(/^[a-z0-9-]+$/);
      expect(p.icon, p.id).not.toContain("/");
    }
  });

  it("is queried by capability, not by id", () => {
    expect(credentialProvidersFor("image-pull").map((p) => p.id)).toEqual(["docker-registry"]);
    expect(credentialProvidersFor("dns").map((p) => p.id)).toEqual(["cloudflare"]);
  });

  it("returns undefined for an unknown id rather than throwing", () => {
    expect(getCredentialProvider("nope")).toBeUndefined();
  });
});

describe("splitCredentialValues", () => {
  it("routes each field by its declared type", () => {
    const { publicFields, secrets } = splitCredentialValues(registry, {
      username: "bob",
      secret: "pat_123",
    });
    expect(publicFields).toEqual({ username: "bob" });
    expect(secrets).toEqual({ secret: "pat_123" });
  });

  it("never lets a secret reach the readable column", () => {
    const { publicFields } = splitCredentialValues(registry, { username: "bob", secret: "pat_123" });
    expect(JSON.stringify(publicFields)).not.toContain("pat_123");
  });

  it("drops keys the provider does not declare", () => {
    // Otherwise a client could park arbitrary data — or a second copy of the secret — in
    // the readable column.
    const { publicFields, secrets } = splitCredentialValues(registry, {
      username: "bob",
      secret: "pat_123",
      sneaky: "whatever",
    } as Record<string, string>);
    expect(publicFields).not.toHaveProperty("sneaky");
    expect(secrets).not.toHaveProperty("sneaky");
  });

  it("omits blank values so an untouched secret is not stored as empty", () => {
    const { secrets } = splitCredentialValues(registry, { username: "bob", secret: "" });
    expect(secrets).toEqual({});
  });

  it("trims readable values but not secrets", () => {
    // A password may legitimately start or end with a space; a username may not.
    const { publicFields, secrets } = splitCredentialValues(registry, {
      username: "  bob  ",
      secret: " pat ",
    });
    expect(publicFields.username).toBe("bob");
    expect(secrets.secret).toBe(" pat ");
  });
});

describe("validateCredentialValues", () => {
  it("requires the declared required fields on create", () => {
    expect(validateCredentialValues(registry, {})).toHaveLength(2);
    expect(validateCredentialValues(registry, { username: "bob", secret: "x" })).toEqual([]);
  });

  it("lets an update keep a secret it already holds", () => {
    // "leave blank to keep" — the editor never re-sends an untouched secret.
    expect(
      validateCredentialValues(registry, { username: "bob" }, { existingSecretKeys: ["secret"] }),
    ).toEqual([]);
  });

  it("still requires a secret that is neither submitted nor held", () => {
    expect(validateCredentialValues(registry, { username: "bob" })).toEqual([
      "Password or access token is required",
    ]);
  });

  it("does not let a held secret excuse a missing readable field", () => {
    expect(
      validateCredentialValues(registry, {}, { existingSecretKeys: ["secret"] }),
    ).toEqual(["Username is required"]);
  });
});

describe("normalizeCredentialSelector", () => {
  it("folds a typed registry host onto the key a pull looks up", () => {
    // The invariant that makes a saved credential findable at deploy time.
    expect(normalizeCredentialSelector(registry, "https://GHCR.IO/")).toBe("ghcr.io");
    expect(normalizeCredentialSelector(registry, "index.docker.io")).toBe("docker.io");
  });

  it("returns null for a provider that has no selector", () => {
    // Never "" — the unique index would then treat two org-wide tokens as distinct.
    expect(normalizeCredentialSelector(cloudflare, "anything")).toBeNull();
    expect(normalizeCredentialSelector(cloudflare, null)).toBeNull();
  });

  it("returns null for a blank selector even when the provider has one", () => {
    expect(normalizeCredentialSelector(registry, "   ")).toBeNull();
  });
});

describe("CREDENTIAL_MASK", () => {
  it("is a constant that reveals nothing about the secret", () => {
    // Not a prefix, not a length hint: a mask that varies with the value leaks part of it.
    expect(CREDENTIAL_MASK).toBe("••••••••");
    expect(CREDENTIAL_MASK).not.toMatch(/[a-z0-9]/i);
  });
});
