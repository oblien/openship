/**
 * Webhook types — shared across all webhook providers.
 *
 * Every provider (GitHub, Stripe) implements the WebhookProvider interface
 * so the central dispatcher can handle verification and routing uniformly.
 */

/** Supported webhook providers */
export type WebhookProviderName = "github" | "stripe";

/** Result of verifying a webhook signature */
export interface WebhookVerifyResult {
  valid: boolean;
  error?: string;
}

/** Standardised result returned by any webhook handler */
export interface WebhookHandlerResult {
  success: boolean;
  event?: string;
  message?: string;
  error?: string;
}

/**
 * Interface every webhook provider must implement.
 *
 * `verify()` checks the cryptographic signature.
 * `handle()` parses the event and dispatches to the correct business-logic handler.
 */
export interface WebhookProvider {
  readonly name: WebhookProviderName;
  verify(payload: string | Buffer, headers: Record<string, string>): WebhookVerifyResult;
  handle(payload: unknown, headers: Record<string, string>): Promise<WebhookHandlerResult>;
}
