// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  analyticsAttribution,
  analyticsScreen,
  configureCloudAnalytics,
  stopCloudAnalytics,
  trackCloudCheckoutReturn,
  trackCloudEvent,
} from "./cloud-analytics";

vi.mock("./api/urls", () => ({ getRestApiBaseUrl: () => "https://api.openship.io/api" }));
const config = { dashboardOrigin: "https://app.openship.io" };
const capture = () =>
  trackCloudEvent({ event: "cloud_page_viewed", properties: { screen: "home" } });
let fetcher: ReturnType<typeof vi.fn>;
const body = (n = -1) => JSON.parse(fetcher.mock.calls.at(n)?.[1]?.body ?? "{}");
beforeEach(() => {
  stopCloudAnalytics();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubGlobal("location", new URL(config.dashboardOrigin));
  window.localStorage.clear();
  delete (window as any).desktop;
  delete (window as any).__OPENSHIP_API_ORIGIN__;
  fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => {
  stopCloudAnalytics();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("isolated Cloud browser analytics", () => {
  it("does not touch analytics storage or network in local, desktop, demo or development", () => {
    const set = vi.spyOn(window.localStorage, "setItem");
    configureCloudAnalytics(undefined, "user", false);
    capture();
    configureCloudAnalytics(config, "user", true);
    capture();
    (window as any).desktop = { isDesktop: true };
    configureCloudAnalytics(config, "user", false);
    capture();
    delete (window as any).desktop;
    (window as any).__OPENSHIP_API_ORIGIN__ = "http://localhost:1234";
    configureCloudAnalytics(config, "user", false);
    capture();
    delete (window as any).__OPENSHIP_API_ORIGIN__;
    vi.stubEnv("NODE_ENV", "development");
    configureCloudAnalytics(config, "user", false);
    capture();
    expect(set).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    set.mockRestore();
  });

  it("sends allowlisted first-party events and preserves the anonymous identity only through its own login", () => {
    configureCloudAnalytics(config, null, false);
    capture();
    const anonymousId = body().anonymousId;
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.openship.io/api/cloud/telemetry");
    expect(body().expectedUserId).toBeNull();
    configureCloudAnalytics(config, "user-a", false);
    capture();
    expect(body().anonymousId).toBe(anonymousId);
    expect(body().expectedUserId).toBe("user-a");
    configureCloudAnalytics(config, null, false);
    capture();
    expect(body().anonymousId).not.toBe(anonymousId);
    const loggedOut = body().anonymousId;
    configureCloudAnalytics(config, "user-b", false);
    capture();
    expect(body().anonymousId).toBe(loggedOut);
    configureCloudAnalytics(config, "user-c", false);
    capture();
    expect(body().anonymousId).not.toBe(loggedOut);
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("posthog.com");
  });

  it("sanitizes routes, referrers and campaign labels before collection", () => {
    expect(analyticsScreen("/projects/secret-id/topology")).toBe("project_topology");
    expect(analyticsScreen("/accept-invite/secret-token")).toBe("other");
    expect(
      analyticsAttribution(
        "https://app.openship.io/?token=secret&utm_source=launch&utm_medium=email&utm_campaign=v0.8.0",
        "https://example.com/private?token=secret",
      ),
    ).toEqual({
      utm_source: "launch",
      utm_medium: "email",
      utm_campaign: "v0.8.0",
      referrer_host: "example.com",
    });
    expect(
      analyticsAttribution(
        "https://app.openship.io/?utm_source=sk_secret&utm_campaign=user%40example.com",
        "http://192.168.1.5/private",
      ),
    ).toEqual({});
    expect(
      analyticsAttribution("https://app.openship.io/", "https://user:secret@example.com/"),
    ).toEqual({});
  });

  it("tracks checkout return navigation without session IDs or payment claims", () => {
    configureCloudAnalytics(config, "user", false);
    trackCloudCheckoutReturn("checkout=success&session_id=cs_SECRET&token=secret");
    expect(body().data).toEqual({
      event: "cloud_checkout_returned",
      properties: { kind: "subscription", result: "success" },
    });
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("SECRET");
    trackCloudCheckoutReturn("topup=cancelled");
    expect(body().data.properties).toEqual({ kind: "topup", result: "cancelled" });
  });

  it("never interrupts checkout/navigation when telemetry networking fails", () => {
    configureCloudAnalytics(config, "user", false);
    fetcher.mockRejectedValueOnce(new Error("offline"));
    expect(capture).not.toThrow();
    fetcher.mockImplementationOnce(() => {
      throw new Error("transport unavailable");
    });
    expect(capture).not.toThrow();
    stopCloudAnalytics();
    const sent = fetcher.mock.calls.length;
    capture();
    expect(fetcher).toHaveBeenCalledTimes(sent);
  });
});
