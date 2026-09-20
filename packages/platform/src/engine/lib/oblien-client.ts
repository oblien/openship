/** SaaS provider clients. Keep construction separate from billing and provisioning. */
import { Oblien } from "@repo/adapters";
import { env } from "../config/env";
import { OblienBillingApi } from "./oblien-billing-api";

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

  _client = new Oblien({ clientId, clientSecret, baseUrl: env.OBLIEN_API_URL });
  return _client;
}

/** Test seam: drop the memoized client so a new env/mock takes effect. */
export function __resetOblienClientForTests(): void {
  _client = null;
}

/** The catalog is public; all other methods require the SaaS master credentials. */
export function getOblienBillingApi(): OblienBillingApi {
  return new OblienBillingApi({
    baseUrl: env.OBLIEN_API_URL,
    ...(env.CLOUD_MODE ? { clientId: env.OBLIEN_CLIENT_ID, clientSecret: env.OBLIEN_CLIENT_SECRET } : {}),
  });
}
