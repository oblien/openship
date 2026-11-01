import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, schema, seedOwner } from "../jobs/_harness";
import { securitySigningBytes } from "@repo/core";
import { getAdvisoryFeed } from "@repo/platform/engine/modules/updates/advisory-feed";
import { buildBackgroundContext } from "@repo/platform/engine/lib/background-context";

const h = vi.hoisted(() => ({ key: "", token: vi.fn() }));
vi.mock("@repo/platform/engine/modules/github/github.token", () => ({ tokenFor: h.token }));
vi.mock("@repo/platform/engine/modules/updates/security-signature", async (original) => {
  const real =
    await original<typeof import("@repo/platform/engine/modules/updates/security-signature")>();
  return {
    verifySecurityManifest: (proof: unknown, options: object) =>
      real.verifySecurityManifest(proof, { ...options, publicKey: h.key }),
  };
});
const keys = generateKeyPairSync("ed25519");
const revision = Date.now();
h.key = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const signed = () => {
  const payload = JSON.stringify({
    format: 1,
    revision,
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    advisories: [],
  });
  return {
    payload,
    signature: sign(null, Buffer.from(securitySigningBytes(payload)), keys.privateKey).toString(
      "base64",
    ),
  };
};
const fetcher = vi.fn();
beforeEach(async () => {
  await db.delete(schema.advisoryFeed);
  h.token.mockReset().mockResolvedValue(null);
  const proof = signed();
  fetcher.mockReset().mockImplementation(async (url) => {
    if (String(url).includes("releases/latest"))
      return Response.json(
        { tag_name: "v0.9.3", body: "not the changelog" },
        { headers: { etag: '"release"' } },
      );
    if (String(url).includes("contents/security"))
      return Response.json(proof, { headers: { etag: '"security"' } });
    if (String(url).endsWith("CHANGELOG.md")) return new Response("## 0.9.3\n\nProduct changes.");
    return Response.json({ advisories: [] });
  });
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => vi.unstubAllGlobals());
const due = () =>
  db.update(schema.advisoryFeed).set({ nextCheckAt: new Date(0), checkedAt: new Date(0) });

describe("shared GitHub advisory transport", () => {
  it("coalesces browsers and scheduler reads and sends no credential to raw content", async () => {
    const owner = await seedOwner();
    const ctx = buildBackgroundContext({ userId: owner.userId, organizationId: owner.orgId });
    h.token.mockResolvedValue({ token: "test-github-secret", source: "user-oauth" });
    const values = await Promise.all(Array.from({ length: 8 }, () => getAdvisoryFeed(ctx)));
    expect(values.every((value) => !value.stale && value.security?.revision === revision)).toBe(
      true,
    );
    expect(values[0].release.latest?.notes).toBe("Product changes.");
    expect(fetcher).toHaveBeenCalledTimes(4);
    for (const [url, options] of fetcher.mock.calls) {
      const auth = new Headers(options?.headers).get("authorization");
      expect(auth).toBe(
        String(url).startsWith("https://api.github.com/") ? "Bearer test-github-secret" : null,
      );
      expect(options.redirect).toBe("error");
    }
    const rows = await db.select().from(schema.advisoryFeed);
    expect(
      rows.every((row) => row.nextCheckAt.getTime() - row.checkedAt!.getTime() === 300_000),
    ).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("test-github-secret");
    await getAdvisoryFeed(ctx);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("uses one-hour anonymous cadence, ETags and cached signed data after 304", async () => {
    await getAdvisoryFeed();
    const rows = await db.select().from(schema.advisoryFeed);
    expect(
      rows.every((row) => row.nextCheckAt.getTime() - row.checkedAt!.getTime() === 3_600_000),
    ).toBe(true);
    await due();
    fetcher.mockClear().mockResolvedValue(new Response(null, { status: 304 }));
    expect((await getAdvisoryFeed()).security?.revision).toBe(revision);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      fetcher.mock.calls.every(([, options]) => new Headers(options.headers).has("if-none-match")),
    ).toBe(true);
  });
  it("retains notices and respects rate-limit backoff across fresh calls", async () => {
    await getAdvisoryFeed();
    await due();
    fetcher
      .mockClear()
      .mockResolvedValue(
        new Response("rate limited", { status: 429, headers: { "retry-after": "7200" } }),
      );
    const value = await getAdvisoryFeed();
    expect(value.security?.revision).toBe(revision);
    expect(value.error).toContain("429");
    expect(Date.parse(value.nextCheckAt!) - Date.now()).toBeGreaterThan(7_100_000);
    await getAdvisoryFeed();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("honors GitHub polling intervals even when a credential is connected later", async () => {
    const normal = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url, options) => {
      const response = await normal(url, options);
      response.headers.set("x-poll-interval", "172800");
      return response;
    });
    await getAdvisoryFeed();
    const rows = await db.select().from(schema.advisoryFeed);
    expect(
      rows.every((row) => row.nextCheckAt.getTime() - row.checkedAt!.getTime() === 172_800_000),
    ).toBe(true);
    const owner = await seedOwner();
    h.token.mockResolvedValue({ token: "test-github-secret", source: "user-oauth" });
    await db.update(schema.advisoryFeed).set({ checkedAt: new Date(Date.now() - 10 * 60_000) });
    const calls = fetcher.mock.calls.length;
    await getAdvisoryFeed(
      buildBackgroundContext({ userId: owner.userId, organizationId: owner.orgId }),
    );
    expect(fetcher).toHaveBeenCalledTimes(calls);
  });
  it("rejects tampering without replacing previously verified notices", async () => {
    await getAdvisoryFeed();
    await due();
    fetcher.mockImplementation(async () =>
      Response.json({ payload: '{"format":1}', signature: "A".repeat(86) + "==" }),
    );
    const value = await getAdvisoryFeed();
    expect(value.security?.revision).toBe(revision);
    expect(value.error).toContain("signature");
  });
  it("accepts the same signed payload after envelope key ordering changes", async () => {
    await getAdvisoryFeed();
    const stored = (await db.select().from(schema.advisoryFeed)).find((row) => row.id === "security")!.body as { payload: string; signature: string };
    await due();
    const normal = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url, options) => String(url).includes("contents/security")
      ? Promise.resolve(Response.json({ signature: stored.signature, payload: stored.payload }))
      : normal(url, options));
    const result = await getAdvisoryFeed();
    expect(result.error).toBeNull();
    expect(result.security?.revision).toBe(revision);
  });
  it("backs off to the anonymous interval when GitHub rejects the credential", async () => {
    const owner = await seedOwner();
    const ctx = buildBackgroundContext({ userId: owner.userId, organizationId: owner.orgId });
    h.token.mockResolvedValue({ token: "expired", source: "user-oauth" });
    const normal = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url, options) =>
      new Headers(options?.headers).has("authorization")
        ? Promise.resolve(new Response(null, { status: 401 }))
        : normal(url, options),
    );
    expect((await getAdvisoryFeed(ctx)).security?.revision).toBe(revision);
    const calls = fetcher.mock.calls.length;
    await db.update(schema.advisoryFeed).set({ checkedAt: new Date(Date.now() - 10 * 60_000) });
    await getAdvisoryFeed(ctx);
    expect(fetcher).toHaveBeenCalledTimes(calls);
    const rows = await db.select().from(schema.advisoryFeed);
    expect(
      rows.every(
        (row) => row.authenticationRejected && row.nextCheckAt.getTime() > Date.now() + 50 * 60_000,
      ),
    ).toBe(true);
  });
});
