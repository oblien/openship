import { oblienWebhookUrl } from "../lib/oblien-webhook-config";

interface CloudBillingEnvironment {
  NODE_ENV: string;
  CLOUD_MODE: boolean;
  BILLING_ENABLED: boolean;
  OBLIEN_CLIENT_ID?: string;
  OBLIEN_CLIENT_SECRET?: string;
  OBLIEN_WEBHOOK_SECRET?: string;
  OBLIEN_WEBHOOK_URL?: string;
}

/** A production API accepting purchases must have its payment integration configured. */
export function assertCloudBillingEnvironment(config: CloudBillingEnvironment, apiOrigin: string): void {
  if (config.NODE_ENV !== "production" || !config.CLOUD_MODE || !config.BILLING_ENABLED) return;

  const required = ["OBLIEN_CLIENT_ID", "OBLIEN_CLIENT_SECRET", "OBLIEN_WEBHOOK_SECRET"] as const;
  const missing = required.filter(key => !config[key]?.trim());
  if (missing.length) {
    throw new Error(
      `Cloud billing is enabled but the API environment is missing: ${missing.join(", ")}. ` +
      "Set these on the deployed API service. Docker Compose loads the root .env, not apps/api/.env.saas.",
    );
  }

  // Uses the same callback rules as registration, including the HTTPS default
  // derived from OPENSHIP_TARGET / OPENSHIP_CLOUD_API_URL.
  oblienWebhookUrl(config.OBLIEN_WEBHOOK_URL, apiOrigin);
}
