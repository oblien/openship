import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyHmacSha256 } from "@repo/platform/engine/modules/webhooks/webhook.service";

/**
 * Locks the GitHub-webhook signature contract the auto-deploy verifier relies
 * on. The verifier (github.webhook.ts `verify`) collects EVERY candidate secret
 * for a delivery's repo (each project's own + cloud bindings + the env legacy
 * fallback) and accepts on `candidates.some(s => verifyHmacSha256(...))`. These
 * tests use the REAL verifyHmacSha256 (a pure leaf) to prove that contract:
 * a delivery signed with one hook's secret verifies iff that secret is among
 * the candidates — the fix for the old "return the FIRST project's secret" bug
 * that silently rejected valid deliveries whenever >1 project shared a repo.
 */

/** GitHub-style `sha256=<hex>` signature. */
function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

const BODY = JSON.stringify({ ref: "refs/heads/main", repository: { full_name: "o/r" } });

describe("verifyHmacSha256", () => {
  it("rejects a multibyte signature without throwing", () => {
    expect(verifyHmacSha256(BODY, "s3cr3t", "é".repeat(sign(BODY, "s3cr3t").length))).toBe(false);
  });
  it("accepts a correct sha256= HMAC of the body", () => {
    expect(verifyHmacSha256(BODY, "s3cr3t", sign(BODY, "s3cr3t"))).toBe(true);
  });
  it("rejects a signature made with the wrong secret", () => {
    expect(verifyHmacSha256(BODY, "s3cr3t", sign(BODY, "other"))).toBe(false);
  });
  it("rejects when the body was tampered after signing", () => {
    expect(verifyHmacSha256(`${BODY} `, "s3cr3t", sign(BODY, "s3cr3t"))).toBe(false);
  });
  it("rejects a malformed / wrong-length signature without throwing", () => {
    expect(verifyHmacSha256(BODY, "s3cr3t", "sha256=deadbeef")).toBe(false);
    expect(verifyHmacSha256(BODY, "s3cr3t", "not-even-close")).toBe(false);
  });
});

describe("multi-candidate verify contract (github.webhook.ts verify)", () => {
  const SA = "project-a-secret";
  const SB = "project-b-secret";
  const ENV = "legacy-env-secret";
  const tryAll = (candidates: string[], signature: string) =>
    candidates.some((s) => verifyHmacSha256(BODY, s, signature));

  it("accepts when the signing secret is among the candidates (>1 project on a repo)", () => {
    const sig = sign(BODY, SB); // delivery signed with project B's hook secret
    expect(tryAll([SA, SB], sig)).toBe(true);
  });

  it("REJECTS when only the first project's secret is tried (the old bug)", () => {
    const sig = sign(BODY, SB);
    expect(tryAll([SA], sig)).toBe(false);
  });

  it("accepts via the env legacy-fallback candidate", () => {
    const sig = sign(BODY, ENV);
    expect(tryAll([SA, ENV], sig)).toBe(true);
  });

  it("fails closed with no candidates (missing secret)", () => {
    expect(tryAll([], sign(BODY, SA))).toBe(false);
  });

  it("rejects a forged signature not matching any candidate", () => {
    expect(tryAll([SA, SB, ENV], sign(BODY, "forged"))).toBe(false);
  });
});
