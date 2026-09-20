import { describe, expect, it } from "vitest";
import { assertCloudBillingEnvironment } from "@repo/platform/engine/config/cloud-billing-env";

const configured = {
  NODE_ENV: "production", CLOUD_MODE: true, BILLING_ENABLED: true,
  OBLIEN_CLIENT_ID: "provider-client", OBLIEN_CLIENT_SECRET: "provider-secret",
  OBLIEN_WEBHOOK_SECRET: "signing-secret",
};
const origin = "https://api.openship.io";

describe("production Cloud billing configuration", () => {
  it.each(["OBLIEN_CLIENT_ID", "OBLIEN_CLIENT_SECRET", "OBLIEN_WEBHOOK_SECRET"] as const)(
    "refuses purchases without %s in the API environment", key => {
      expect(() => assertCloudBillingEnvironment({ ...configured, [key]: "  " }, origin)).toThrow(key);
    },
  );

  it("lists missing variable names without exposing configured secrets", () => {
    let error: unknown;
    try {
      assertCloudBillingEnvironment({ ...configured, OBLIEN_CLIENT_ID: undefined, OBLIEN_WEBHOOK_SECRET: undefined }, origin);
    } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("OBLIEN_CLIENT_ID, OBLIEN_WEBHOOK_SECRET");
    expect((error as Error).message).toContain("root .env");
    expect((error as Error).message).not.toContain(configured.OBLIEN_CLIENT_SECRET);
  });

  it("accepts the deployed API origin or an explicit HTTPS callback", () => {
    expect(() => assertCloudBillingEnvironment(configured, origin)).not.toThrow();
    expect(() => assertCloudBillingEnvironment({
      ...configured, OBLIEN_WEBHOOK_URL: "https://staging.example.test/api/billing/oblien-webhook",
    }, "http://localhost:4100")).not.toThrow();
  });

  it.each([
    "http://api.example.test/api/billing/oblien-webhook",
    "https://private:secret@api.example.test/api/billing/oblien-webhook",
    "https://api.example.test/api/billing/oblien-webhook?secret=private",
  ])("rejects an invalid callback at startup", callback => {
    expect(() => assertCloudBillingEnvironment({ ...configured, OBLIEN_WEBHOOK_URL: callback }, origin))
      .toThrow("public HTTPS OBLIEN_WEBHOOK_URL");
  });

  it("catches a production SaaS accidentally using localhost runtime URLs", () => {
    expect(() => assertCloudBillingEnvironment(configured, "http://localhost:4000"))
      .toThrow("public HTTPS OBLIEN_WEBHOOK_URL");
  });

  it.each([
    { NODE_ENV: "development", CLOUD_MODE: true, BILLING_ENABLED: true },
    { NODE_ENV: "test", CLOUD_MODE: true, BILLING_ENABLED: true },
    { NODE_ENV: "production", CLOUD_MODE: false, BILLING_ENABLED: true },
    { NODE_ENV: "production", CLOUD_MODE: true, BILLING_ENABLED: false },
  ])("preserves development, self-hosted and disabled-purchase modes: %j", config => {
    expect(() => assertCloudBillingEnvironment(config, "http://localhost:4000")).not.toThrow();
  });
});
