import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  verifyOblienSignature,
  deriveOblienEventId,
  extractNamespace,
  type OblienEventEnvelope,
} from "@repo/platform/engine/modules/billing/oblien-webhook-crypto";

const SECRET = "whsec_test_oblien_123";

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("verifyOblienSignature", () => {
  const body = JSON.stringify({ event: "credits.usage", data: { namespace: "os-abc" } });

  it("accepts a correct HMAC-SHA256 hex of the raw body", () => {
    expect(verifyOblienSignature(body, sign(body), SECRET)).toEqual({ ok: true });
  });

  it("tolerates a sha256= prefix", () => {
    expect(verifyOblienSignature(body, `sha256=${sign(body)}`, SECRET)).toEqual({ ok: true });
  });

  it("rejects a signature made with the wrong secret", () => {
    const bad = verifyOblienSignature(body, sign(body, "nope"), SECRET);
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe("bad_signature");
  });

  it("rejects when the body was tampered after signing", () => {
    const sig = sign(body);
    const res = verifyOblienSignature(body + " ", sig, SECRET);
    expect(res).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("reports missing_header when no signature is present", () => {
    expect(verifyOblienSignature(body, undefined, SECRET)).toEqual({
      ok: false,
      reason: "missing_header",
    });
  });

  it("reports no_secret when the webhook secret isn't configured", () => {
    expect(verifyOblienSignature(body, sign(body), undefined)).toEqual({
      ok: false,
      reason: "no_secret",
    });
  });

  it("treats a non-hex signature of matching length as a mismatch (no throw)", () => {
    const sig = sign(body);
    const garbage = "z".repeat(sig.length);
    expect(verifyOblienSignature(body, garbage, SECRET)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });
});

describe("deriveOblienEventId", () => {
  const base: OblienEventEnvelope = {
    event: "credits.usage",
    timestamp: "2026-07-21T10:00:00Z",
    data: { namespace: "os-abc", workspace_id: "ws_1", period_end: "2026-08-01T00:00:00Z" },
  };

  it("is deterministic for the same payload", () => {
    expect(deriveOblienEventId(base)).toBe(deriveOblienEventId({ ...base }));
  });

  it("differs across event types", () => {
    expect(deriveOblienEventId(base)).not.toBe(
      deriveOblienEventId({ ...base, event: "credits.depleted" }),
    );
  });

  it("collapses provider retries using their stable delivery id", () => {
    const a = deriveOblienEventId(base, "evt-stable");
    const b = deriveOblienEventId({ ...base, timestamp: "later-but-same-period" }, "evt-stable");
    expect(a).toBe(b);
  });

  it("uses the signed event identity while keeping different namespaces isolated", () => {
    const current = { ...base, id: "evt-signed" };
    expect(deriveOblienEventId(current, "evt-signed")).toBe(deriveOblienEventId({ ...current, timestamp: "later" }, "evt-signed"));
    expect(deriveOblienEventId(current)).not.toBe(deriveOblienEventId({ ...current, data: { namespace: "os-another" } }));
  });

  it("keeps different usage updates within the same billing period", () => {
    const first = { ...base, data: { ...base.data, credits_used: 10 } };
    const second = { ...base, data: { ...base.data, credits_used: 20 } };
    expect(deriveOblienEventId(first)).not.toBe(deriveOblienEventId(second));
  });

  it("keeps distinct periods distinct", () => {
    const a = deriveOblienEventId(base);
    const b = deriveOblienEventId({
      ...base,
      data: { ...base.data, period_end: "2026-09-01T00:00:00Z" },
    });
    expect(a).not.toBe(b);
  });

  it("uses timestamp to distinguish deliveries without a period_end", () => {
    const noPeriod: OblienEventEnvelope = {
      event: "credits.low",
      timestamp: "t1",
      data: { namespace: "os-abc" },
    };
    const a = deriveOblienEventId(noPeriod);
    const b = deriveOblienEventId({ ...noPeriod, timestamp: "t2" });
    expect(a).not.toBe(b);
  });
});

describe("extractNamespace", () => {
  it("prefers data.namespace, falls back to top-level", () => {
    expect(extractNamespace({ data: { namespace: "os-inner" }, namespace: "os-outer" })).toBe(
      "os-inner",
    );
    expect(extractNamespace({ namespace: "os-outer" })).toBe("os-outer");
    expect(extractNamespace({})).toBeNull();
  });
});
