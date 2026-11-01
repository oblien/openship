import { describe, expect, it, vi } from "vitest";
import { createInstanceAuthorization } from "../src/instance-authorization";
import { freezeContext, type ExecutionContext } from "../src/context";

const context = (patch: Partial<ExecutionContext> = {}) => freezeContext({
  userId: "alice", user: { id: "alice", email: "alice@example.test", name: null },
  sessionId: "session", sessionKind: "native", organizationId: "org-a",
  membershipId: "member-a", role: "owner", scopeMode: "fixed",
  clientIp: null, userAgent: null, traceId: "trace", ...patch,
});

describe("shared instance authority", () => {
  it("does not derive instance authority from organization ownership", async () => {
    const findUserRole = vi.fn(async () => "user");
    const policy = createInstanceAuthorization({ findUserRole });
    await expect(policy.assert(context())).rejects.toMatchObject({ statusCode: 403 });
    expect(findUserRole).toHaveBeenCalledWith("alice");
    await expect(policy.allows(context({ organizationId: "another-org" }))).resolves.toBe(false);
  });

  it("observes role revocation on an existing context", async () => {
    const findUserRole = vi.fn(async () => "admin");
    const policy = createInstanceAuthorization({ findUserRole });
    const ctx = context();
    await expect(policy.assert(ctx)).resolves.toBeUndefined();
    findUserRole.mockResolvedValue("user");
    await expect(policy.assert(ctx)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("never widens scoped credentials to their administrator owner's authority", async () => {
    const findUserRole = vi.fn(async () => "admin");
    const policy = createInstanceAuthorization({ findUserRole });
    for (const patch of [
      { tokenScope: { tokenId: "token" } },
      { credential: { organizationId: "org-a", readOnly: false } },
    ]) await expect(policy.allows(context(patch), "read")).resolves.toBe(false);
    expect(findUserRole).not.toHaveBeenCalled();
  });

  it("honors expiry and read-only restrictions before an instance mutation", async () => {
    const policy = createInstanceAuthorization({ findUserRole: async () => "admin", now: () => 100 });
    const readOnly = context({ credential: { organizationId: null, readOnly: true } });
    await expect(policy.allows(readOnly, "read")).resolves.toBe(true);
    await expect(policy.assert(readOnly)).rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
    await expect(policy.assert(context({ credential: { organizationId: null, readOnly: false, expiresAt: 99 } })))
      .rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
