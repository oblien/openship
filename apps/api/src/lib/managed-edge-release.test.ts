import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `releaseManagedHostnames` is the one place a freed `*.opsh.io` slug is given
 * back. It is worth pinning because both of its properties are silently
 * regressible: passing a non-managed hostname must NOT reach the cloud at all
 * (an operator's own `api.example.com` is not ours to deregister), and the slug
 * derivation must actually happen (an earlier version tested the raw `domain`
 * column, which holds a bare slug, so the suffix check matched nothing and the
 * release quietly did nothing).
 */

const deregister = vi.fn(async () => ({ ok: true as const, removed: true }));

vi.mock("./cloud/client", () => ({
  cloudClient: () => ({ edgeProxy: { deregister } }),
}));

// The suffix comes from SYSTEM.DOMAINS.CLOUD_DOMAIN; stub the predicate pair so
// the test doesn't depend on env-resolved routing config.
vi.mock("./public-endpoints", () => ({
  isCloudManagedHostname: (h: string) => h.endsWith(".opsh.io"),
  managedHostnameToSlug: (h: string) =>
    h.endsWith(".opsh.io") ? h.slice(0, -".opsh.io".length) : undefined,
}));

const { releaseManagedHostnames } = await import("./managed-edge-proxy");

describe("releaseManagedHostnames", () => {
  beforeEach(() => deregister.mockClear());

  it("releases a managed hostname by its derived SLUG, not the hostname", () => {
    return releaseManagedHostnames(["my-app.opsh.io"], { organizationId: "org_1" }).then((r) => {
      expect(deregister).toHaveBeenCalledWith("my-app");
      expect(r.failures).toEqual([]);
    });
  });

  it("never touches the cloud for a hostname that is not ours", async () => {
    // A custom domain, and a managed-looking subdomain of the operator's OWN
    // HOST_DOMAIN. Deregistering either would be us deleting a route we do not
    // own — and for a custom domain there is no cloud route to delete at all.
    const r = await releaseManagedHostnames(
      ["shop.example.com", "api.example.com", null, undefined, ""],
      { organizationId: "org_1" },
    );
    expect(deregister).not.toHaveBeenCalled();
    expect(r.failures).toEqual([]);
  });

  it("deduplicates so one slug is released once", async () => {
    await releaseManagedHostnames(["dup.opsh.io", "dup.opsh.io"], { organizationId: "org_1" });
    expect(deregister).toHaveBeenCalledTimes(1);
  });

  it("reports a failure per slug instead of throwing", async () => {
    // The caller decides what a failure means: the interactive domain delete
    // refuses and keeps the row (retryable), while teardown records it. Throwing
    // from here would take that choice away.
    deregister.mockRejectedValueOnce(new Error("cloud unreachable"));
    const r = await releaseManagedHostnames(["a.opsh.io", "b.opsh.io"], {
      organizationId: "org_1",
    });
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("a");
    // The second slug is still attempted — one unreachable route must not strand
    // the rest.
    expect(deregister).toHaveBeenCalledTimes(2);
  });

  it("makes no call when there is nothing managed to release", async () => {
    const r = await releaseManagedHostnames([], { organizationId: "org_1" });
    expect(deregister).not.toHaveBeenCalled();
    expect(r.failures).toEqual([]);
  });
});
