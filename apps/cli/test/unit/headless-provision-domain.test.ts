import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The self-app's own custom domain must be provisioned on BOTH install methods.
 *
 * Compose used to be skipped here — it registered `byo` plus a "add it from the
 * Domains tab" warning — on the belief that self-register would install and take
 * over the HOST's OpenResty and fight the container edge. It doesn't: with
 * OPENSHIP_EDGE_MODE=docker the api's `ensureSelfEdgeInfra` returns early and
 * installs nothing, then routes + certs through the edge CONTAINER. The wizard
 * that collects a hostname, prints the DNS record, and promises automatic HTTPS
 * has to actually request it.
 */

const h = vi.hoisted(() => ({
  posts: [] as Array<{ path: string; body: Record<string, unknown> }>,
}));

vi.mock("../../src/lib/loopback-api", () => ({
  internalPost: async (_port: string, path: string, body: Record<string, unknown>) => {
    h.posts.push({ path, body });
    return { ok: true, data: { url: "https://ops.example.com" } };
  },
  waitHealthy: async () => true,
  bootstrapAdmin: async () => ({ ok: true, message: "created" }),
  ensureInternalToken: () => "tok",
}));

import { headlessProvision } from "../../src/lib/instance-provision";

const inputs = {
  admin: { email: "a@b.com", name: "a", password: "supersecret" },
  domain: { kind: "custom" as const, hostname: "ops.example.com", acmeEmail: "a@b.com", edge: "takeover" as const },
};

const selfRegister = () => h.posts.find((p) => p.path === "/api/system/self-register");

beforeEach(() => {
  h.posts = [];
});

describe("headlessProvision — self-app custom domain", () => {
  it("requests the custom domain on COMPOSE (container edge issues the cert)", async () => {
    const res = await headlessProvision({ port: "4000", dashPort: "3001", inputs, method: "compose" });

    expect(selfRegister()?.body.domainType).toBe("custom");
    expect(selfRegister()?.body.hostname).toBe("ops.example.com");
    expect(selfRegister()?.body.dashPort).toBe(3001);
    // The old behavior: byo + "not auto-provisioned" warning. Neither may return.
    expect(selfRegister()?.body.domainType).not.toBe("byo");
    expect(res.warnings.join(" ")).not.toMatch(/not auto-provisioned/i);
    expect(res.liveUrl).toBe("https://ops.example.com");
  });

  it("sends the identical request on BARE", async () => {
    await headlessProvision({ port: "4000", dashPort: "3001", inputs, method: "bare" });
    expect(selfRegister()?.body.domainType).toBe("custom");
    expect(selfRegister()?.body.edgeTakeover).toBe(true);
    expect(selfRegister()?.body.edgeMigrate).toBe(false);
  });
});
