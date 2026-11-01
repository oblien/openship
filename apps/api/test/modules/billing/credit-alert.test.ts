import { describe, it, expect } from "vitest";
import { creditAlertNotification } from "@repo/platform/engine/modules/billing/billing-credit-alert";
import type { OblienEntitlement } from "@repo/platform/engine/lib/oblien-billing-api";

const state = (changes = {}) =>
  ({
    namespace: "tenant",
    status: "active",
    periodStart: "2026-09-01T00:00:00Z",
    quota: {
      alert: {
        state: "low",
        percent: 95,
        threshold: 95,
        limit: 4000,
        remaining: 200,
        balance: 200,
        ...changes,
      },
    },
  }) as OblienEntitlement;
const input = {
  eventType: "namespace.quota.threshold",
  eventId: "evt1",
  timestamp: "2026-09-28T00:00:00Z",
  data: { namespace: "tenant", service: "workspace_vm", threshold: 95, alert: { limit: 4000 } },
  organizationId: "org-a",
  dashboardUrl: "https://app.openship.io",
  entitlement: state(),
};

describe("provider credit alerts", () => {
  it("uses current provider numbers and an organization-bound billing link", () => {
    const result = creditAlertNotification(input)!;
    expect(result.payload.message).toContain("95%");
    expect(result.payload.message).toContain("200 credits");
    expect(result.payload.url).toBe("https://app.openship.io/cloud-billing?organizationId=org-a");
    expect(result.idempotencyKey).toBe("evt1");
  });
  it("drops a late warning after a top-up, renewal, or a newer warning band", () => {
    expect(
      creditAlertNotification({ ...input, entitlement: state({ state: "ok", percent: 20 }) }),
    ).toBeNull();
    expect(creditAlertNotification({ ...input, entitlement: state({ limit: 8000 }) })).toBeNull();
    expect(creditAlertNotification({ ...input, timestamp: "2026-08-31T23:59:59Z" })).toBeNull();
    expect(
      creditAlertNotification({ ...input, data: { ...input.data, threshold: 80 } }),
    ).toBeNull();
  });
  it("never fabricates a percentage or warns for another service", () => {
    expect(
      creditAlertNotification({
        ...input,
        entitlement: { ...state(), quota: { limit: 1, used: 0, balance: 1 } },
      }),
    ).toBeNull();
    expect(
      creditAlertNotification({ ...input, data: { ...input.data, service: "compute" } }),
    ).toBeNull();
    expect(creditAlertNotification({ ...input, eventType: "credits.low" })).toBeNull();
  });
  it("distinguishes grace from exhaustion and suppresses a stale depletion after recovery", () => {
    const grace = creditAlertNotification({
      ...input,
      eventType: "credits.low",
      entitlement: state({ state: "grace", balance: 60 }),
    });
    expect(grace?.payload.message).toContain("60 grace credits");
    const depleted = {
      ...state({ state: "depleted", balance: 0 }),
      status: "credit_exhausted" as const,
    };
    expect(
      creditAlertNotification({ ...input, eventType: "credits.depleted", entitlement: depleted })
        ?.eventType,
    ).toBe("billing.credit_exhausted");
    expect(
      creditAlertNotification({ ...input, eventType: "credits.depleted", entitlement: state() }),
    ).toBeNull();
    expect(
      creditAlertNotification({
        ...input,
        eventType: "namespace.suspended",
        entitlement: depleted,
      }),
    ).toBeNull();
  });
});
