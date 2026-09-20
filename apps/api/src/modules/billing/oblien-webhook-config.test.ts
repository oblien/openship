import { describe, expect, it } from "vitest";
import { OBLIEN_WEBHOOK_EVENTS, oblienWebhookUrl } from "@repo/platform/engine/lib/oblien-webhook-config";

describe("Oblien callback configuration", () => {
  it("targets the public API instead of the dashboard origin", () => {
    expect(oblienWebhookUrl(undefined, "https://api.openship.io/"))
      .toBe("https://api.openship.io/api/billing/oblien-webhook");
    expect(oblienWebhookUrl("https://staging.example/api/proxy/api/billing/oblien-webhook", "http://localhost:4000"))
      .toBe("https://staging.example/api/proxy/api/billing/oblien-webhook");
  });
  it("requires a public HTTPS callback and keeps credentials out of callback URLs", () => {
    for (const url of ["http://localhost:4000/hook", "https://user:password@example.com/hook", "https://example.com/hook?token=secret"]) {
      expect(() => oblienWebhookUrl(url, "https://api.openship.io")).toThrow("public HTTPS");
    }
  });
  it("subscribes to payment, renewal, suspension and restoration events", () => {
    expect(OBLIEN_WEBHOOK_EVENTS).toEqual(expect.arrayContaining([
      "payment.succeeded", "subscription.renewed", "subscription.past_due", "subscription.canceled", "subscription.updated",
      "entitlement.changed", "namespace.suspended", "namespace.restored",
    ]));
  });
});
