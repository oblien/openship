import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  config: null as unknown,
  schedule: vi.fn(),
  claim: vi.fn(),
  checkouts: vi.fn(),
  prune: vi.fn(),
  observed: vi.fn(),
  status: vi.fn(),
}));
vi.mock("@repo/db", () => ({
  repos: {
    cloudAnalytics: {
      claim: h.claim,
      claimCheckouts: h.checkouts,
      prune: h.prune,
      observedCheckout: h.observed,
    },
  },
}));
vi.mock("@repo/platform/engine/modules/cloud-analytics/config", () => ({
  getCloudAnalyticsConfig: () => h.config,
}));
vi.mock("@repo/platform/engine/lib/system-jobs", () => ({ scheduleSystemJob: h.schedule }));
vi.mock("@repo/platform/engine/modules/billing/billing.service", () => ({
  getCheckoutStatus: h.status,
}));
import { startCloudAnalytics } from "@repo/platform/engine/modules/cloud-analytics/index";

beforeEach(() => {
  vi.clearAllMocks();
  h.config = {
    key: "phc_test",
    host: "https://us.i.posthog.com",
    excludedOrganizations: new Set(),
    excludedUsers: new Set(),
  };
  h.claim.mockResolvedValue([]);
  h.checkouts.mockResolvedValue([]);
  h.prune.mockResolvedValue(undefined);
  h.observed.mockResolvedValue(undefined);
  h.status.mockResolvedValue({});
});
describe("bounded Cloud analytics worker", () => {
  it("does not register jobs or touch storage while disabled", async () => {
    h.config = null;
    await startCloudAnalytics();
    expect(h.schedule).not.toHaveBeenCalled();
    expect(h.claim).not.toHaveBeenCalled();
  });
  it("reconciles without a browser return, with at most four provider requests in flight", async () => {
    h.checkouts.mockResolvedValue(
      Array.from({ length: 20 }, (_, n) => ({
        id: `cs-${n}`,
        organizationId: "org",
        userId: "user",
        createdAt: new Date(),
        checks: 1,
      })),
    );
    let active = 0;
    let peak = 0;
    h.status.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
    });
    await startCloudAnalytics();
    expect(h.schedule.mock.calls[0]?.[0]).toMatchObject({
      jobId: "cloud-analytics:deliver",
      cronExpression: "* * * * *",
    });
    await h.schedule.mock.calls[0]![0].run();
    expect(h.status).toHaveBeenCalledTimes(20);
    expect(peak).toBe(4);
  });
  it("stops old unresolved polls, but permits a fresh webhook check for an old checkout", async () => {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60_000);
    h.checkouts.mockResolvedValue([
      {
        id: "old-open",
        organizationId: "org",
        userId: "user",
        createdAt: old,
        checks: 15,
        status: "pending",
      },
      {
        id: "old-refund",
        organizationId: "org",
        userId: "user",
        createdAt: old,
        checks: 1,
        status: "completed",
      },
    ]);
    await startCloudAnalytics();
    await h.schedule.mock.calls[0]![0].run();
    expect(h.observed).toHaveBeenCalledWith("org", "old-open", "pending", null);
    expect(h.status).toHaveBeenCalledExactlyOnceWith("org", "old-refund");
  });
});
