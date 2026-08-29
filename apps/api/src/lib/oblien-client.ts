/**
 * The master Oblien SDK client — a LEAF module by design.
 *
 * It exists on its own so nothing has to import `openship-cloud.ts` just to get a
 * client. That file both needs the client and needs the billing module's
 * `setQuotaForTier`, while the billing module needs the client — routing the client
 * through `openship-cloud` therefore made `openship-cloud ⇄ billing-oblien-quota`
 * a genuine import cycle, which was previously papered over with a dynamic
 * `await import()` inside the spend path.
 *
 * A dynamic import does not break a cycle, it hides one, and hiding it had a real
 * cost: the desktop app ships this API as a `Bun.build` node bundle, and a bundler
 * is free to order a flattened cycle so one side's binding is still `undefined`
 * when the other side's function body runs. Depending on ESM hoisting to save us
 * is a bet, not a design. This module has exactly two dependencies — `env` and the
 * SDK — so it can sit underneath everything and the cycle simply does not form.
 */

import { Oblien } from "@repo/adapters";
import { env } from "../config/env";

let _client: Oblien | null = null;

export function getOblienClient(): Oblien {
  if (_client) return _client;

  // Hard gate: master Oblien credentials must only live on the SaaS
  // API process. If a self-hosted install somehow set OBLIEN_CLIENT_ID
  // (env-var typo, copied .env from cloud, etc.) and called this
  // function, the resulting client would have multi-tenant authority
  // — refuse to instantiate. CLOUD_MODE is the same flag every other
  // SaaS-only code path checks (cloud-saas.controller, namespace
  // minting), so this stays in lockstep with the rest of the boundary.
  if (!env.CLOUD_MODE) {
    throw new Error(
      "Oblien master client is only available in CLOUD_MODE — refusing to instantiate on self-hosted",
    );
  }

  const clientId = env.OBLIEN_CLIENT_ID;
  const clientSecret = env.OBLIEN_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Oblien credentials not configured (OBLIEN_CLIENT_ID / OBLIEN_CLIENT_SECRET)");
  }

  _client = new Oblien({ clientId, clientSecret });
  return _client;
}

/** Test seam: drop the memoized client so a new env/mock takes effect. */
export function __resetOblienClientForTests(): void {
  _client = null;
}
