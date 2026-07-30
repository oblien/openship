import { describe, it, expect, afterEach } from "vitest";
import { resolveInstallInputs, HeadlessInputError } from "../../src/lib/instance-provision";

// resolveInstallInputs is the pure arg→inputs resolver behind `openship up
// --non-interactive`. It must NEVER silently default a credential and must give
// a precise error on anything missing/invalid.

const OK = { adminEmail: "a@b.com", adminPassword: "supersecret" };

describe("resolveInstallInputs", () => {
  const prev = process.env.OPENSHIP_ADMIN_PASSWORD;
  afterEach(() => {
    if (prev === undefined) delete process.env.OPENSHIP_ADMIN_PASSWORD;
    else process.env.OPENSHIP_ADMIN_PASSWORD = prev;
  });

  it("resolves a byo install from flags", () => {
    const r = resolveInstallInputs({ ...OK, domainKind: "byo", hostname: "ops.example.com" });
    expect(r.admin.email).toBe("a@b.com");
    expect(r.admin.name).toBe("a"); // derived from the email local-part
    expect(r.domain).toEqual({ kind: "byo", hostname: "ops.example.com" });
  });

  it("defaults domain kind: none with no domain, byo when --public-url is set", () => {
    expect(resolveInstallInputs(OK).domain).toEqual({ kind: "none" });
    const r = resolveInstallInputs({ ...OK, publicUrl: "https://ops.example.com" });
    expect(r.domain).toEqual({ kind: "byo", hostname: "ops.example.com" });
  });

  it("reads the password from OPENSHIP_ADMIN_PASSWORD when the flag is absent", () => {
    process.env.OPENSHIP_ADMIN_PASSWORD = "fromenvsecret";
    const r = resolveInstallInputs({ adminEmail: "a@b.com" });
    expect(r.admin.password).toBe("fromenvsecret");
  });

  it("throws on missing/invalid email", () => {
    expect(() => resolveInstallInputs({ adminPassword: "supersecret" })).toThrow(HeadlessInputError);
    expect(() => resolveInstallInputs({ adminEmail: "nope", adminPassword: "supersecret" })).toThrow(
      HeadlessInputError,
    );
  });

  it("throws on a too-short / missing password", () => {
    delete process.env.OPENSHIP_ADMIN_PASSWORD;
    expect(() => resolveInstallInputs({ adminEmail: "a@b.com" })).toThrow(HeadlessInputError);
    expect(() => resolveInstallInputs({ adminEmail: "a@b.com", adminPassword: "short" })).toThrow(
      HeadlessInputError,
    );
  });

  it("custom requires a hostname and validates --edge", () => {
    expect(() => resolveInstallInputs({ ...OK, domainKind: "custom" })).toThrow(HeadlessInputError);
    const r = resolveInstallInputs({ ...OK, domainKind: "custom", hostname: "ops.example.com", edge: "takeover" });
    expect(r.domain).toMatchObject({ kind: "custom", hostname: "ops.example.com", edge: "takeover" });
    expect(() =>
      resolveInstallInputs({ ...OK, domainKind: "custom", hostname: "ops.example.com", edge: "bogus" }),
    ).toThrow(HeadlessInputError);
  });

  it("free requires a valid slug (or derives it from the hostname)", () => {
    expect(() => resolveInstallInputs({ ...OK, domainKind: "free" })).toThrow(HeadlessInputError);
    const r = resolveInstallInputs({ ...OK, domainKind: "free", slug: "my-app" });
    expect(r.domain).toMatchObject({ kind: "free", slug: "my-app" });
  });

  it("rejects an unknown domain kind", () => {
    expect(() => resolveInstallInputs({ ...OK, domainKind: "bananas" })).toThrow(HeadlessInputError);
  });
});
