/**
 * Webhook types - shared across all webhook providers.
 *
 * Every registered Git provider implements the WebhookProvider interface
 * so the central dispatcher can handle verification and routing uniformly.
 */

import type { RegisteredGitProvider } from "@repo/core";

/** Supported webhook providers */
// Stripe is handled by its own billing route (SDK-verified), not this generic
// provider registry.
export type WebhookProviderName = RegisteredGitProvider["id"];

/** Result of verifying a webhook signature */
export interface WebhookVerifyResult {
  valid: boolean;
  /** Organization-bound signatures can authorize only their signers' workspaces. */
  organizationIds?: readonly string[];
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
 * `verify()` checks the cryptographic signature. Returning a Promise is
 * allowed because some providers must resolve per-resource secrets from
 * the DB before they can HMAC-check (e.g. github's per-project secret —
 * see HIGH #9 in the GitHub-auth audit).
 *
 * `handle()` parses the event and dispatches to the correct business-logic handler.
 */
export interface WebhookProvider<Verification extends WebhookVerifyResult = WebhookVerifyResult> {
  readonly name: WebhookProviderName;
  verify(
    payload: string | Buffer,
    headers: Record<string, string>,
  ): Verification | Promise<Verification>;
  handle(payload: unknown, headers: Record<string, string>, verification?: Verification): Promise<WebhookHandlerResult>;
}
