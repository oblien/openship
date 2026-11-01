import { describe, expect, it } from "vitest";
import { pbkdf2Sync } from "node:crypto";
import {
  assertRouteProtection,
  createRouteProtection,
  revokeRouteSessions,
  withRouteProtectionRuntime,
} from "./route-protection";

describe("route protection policy", () => {
  it("uses independent salted verifiers and rotates sessions without changing the password", async () => {
    const password = "a private site password";
    const a = await createRouteProtection(password);
    const b = await createRouteProtection(password);
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.signingKey).not.toBe(b.signingKey);
    expect(
      pbkdf2Sync(password, Buffer.from(a.salt, "hex"), a.iterations, 32, "sha256").toString("hex"),
    ).toBe(a.verifier);
    const next = revokeRouteSessions(a);
    expect(next.verifier).toBe(a.verifier);
    expect(next.salt).toBe(a.salt);
    expect(next.version).not.toBe(a.version);
    expect(next.signingKey).not.toBe(a.signingKey);
    expect(() => assertRouteProtection({ ...a, sessionSeconds: Number.MAX_VALUE })).toThrow();
    expect(() => assertRouteProtection({ ...a, signingKey: "bad" })).toThrow();
    await expect(createRouteProtection("short")).rejects.toThrow();
    await expect(createRouteProtection("🙂".repeat(100))).rejects.toThrow();
  });

  it("upgrades a legacy bare config idempotently without replacing operator settings", () => {
    const old =
      "worker_processes 3;\nevents { worker_connections 800; }\nhttp {\n  keepalive_timeout 40;\n}\n";
    const next = withRouteProtectionRuntime(old);
    expect(next).toContain("keepalive_timeout 40;");
    expect(next).toContain("worker_processes 3;");
    expect(withRouteProtectionRuntime(next)).toBe(next);
    expect(() => withRouteProtectionRuntime("events {}")).toThrow(/http block/);
  });
});
