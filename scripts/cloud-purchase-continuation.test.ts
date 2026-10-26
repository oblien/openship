import { expect, it } from "bun:test";
import { CLOUD_DASHBOARD_URL } from "@repo/core";
import { cloudPlanHref, managePlanHref } from "../apps/web/src/lib/cloud-links";
import { newServerBillingHref } from "../apps/dashboard/src/lib/billing-links";

it.each(["monthly", "annual"] as const)(
  "preserves %s pricing through the organization handoff",
  (interval) => {
    const link = new URL(cloudPlanHref("starter", interval));
    expect(link.searchParams.get("interval")).toBe(interval);
    const scoped = new URL(
      newServerBillingHref("org-b", { planId: "starter", interval, startCheckout: true }),
      CLOUD_DASHBOARD_URL,
    );
    expect(scoped.searchParams.get("interval")).toBe(interval);
    expect(scoped.searchParams.get("organizationId")).toBe("org-b");
    expect(scoped.searchParams.has("workspaceId")).toBe(false);
  },
);

it("sends a marketing plan choice directly to Cloud's new-server purchase", () => {
  const link = new URL(cloudPlanHref("starter"));
  expect(link.origin).toBe(new URL(CLOUD_DASHBOARD_URL).origin);
  expect(link.pathname).toBe("/billing/plans");
  expect(link.searchParams.get("newServer")).toBe("1");
  expect(link.searchParams.get("plan")).toBe("starter");
  expect(link.searchParams.get("startCheckout")).toBe("1");
  expect(new URL(cloudPlanHref()).searchParams.has("plan")).toBe(false);
  expect(new URL(cloudPlanHref()).searchParams.has("startCheckout")).toBe(false);
});

it("encodes the plan as a value so it cannot inject a host or another server", () => {
  const input = "starter&workspaceId=foreign#//evil.test";
  const link = new URL(cloudPlanHref(input));
  expect(link.origin).toBe(new URL(CLOUD_DASHBOARD_URL).origin);
  expect(link.searchParams.get("plan")).toBe(input);
  expect(link.searchParams.has("workspaceId")).toBe(false);
  expect(link.hash).toBe("");
});

it.each(["basic", "priority"] as const)("preserves the %s management choice", (plan) => {
  const link = new URL(managePlanHref(plan));
  expect(link.origin).toBe(new URL(CLOUD_DASHBOARD_URL).origin);
  expect(link.pathname).toBe("/billing/manage");
  expect(link.searchParams.get("plan")).toBe(plan);
});
