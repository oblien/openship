/**
 * "Does this credential actually work?" — asked before it is stored, and again on demand.
 *
 * Verifying up front is the convention the DNS slice already set, for the reason its own
 * comment gives: a credential that was never valid is worse than none, because it
 * silently owns the lookup for every consumer that matches it. A registry login that
 * cannot authenticate would take over every pull from that host and turn a working
 * anonymous pull into a failing authenticated one.
 *
 * One verifier per provider, dispatched by id. A provider with no verifier is a
 * programming error, not a runtime condition — `verifyCredential` refuses rather than
 * quietly storing something unproven.
 *
 * REDACTION: a verifier's `reason` reaches the operator and the `credential.last_error`
 * column. It may name what failed (401, host unreachable, DNS token lacks Zone:Read) and
 * must never carry the credential, a prefix of it, or a provider response body — those
 * routinely echo the request, and a body pasted into a support thread is a leaked secret.
 */

import { safeErrorMessage, DOCKER_HUB_REGISTRY, type CredentialProvider } from "@repo/core";
import { env } from "../../config/env";
import { safeFetch, type SafeFetchResponse } from "../../lib/safe-fetch";

export interface VerifyResult {
  ok: boolean;
  /** Redacted, operator-facing. Absent when ok. */
  reason?: string;
}

/** Secrets as decrypted, keyed by the provider's field keys. */
export type CredentialSecrets = Record<string, string>;

type Verifier = (args: {
  selector: string | null;
  publicFields: Record<string, string>;
  secrets: CredentialSecrets;
}) => Promise<VerifyResult>;

/** Bound so a hostile or misconfigured registry cannot hang a settings request. */
const VERIFY_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(
  url: string,
  headers?: Record<string, string>,
): Promise<SafeFetchResponse> {
  return safeFetch(url, {
    headers,
    timeoutMs: VERIFY_TIMEOUT_MS,
    // A self-hosted operator may intentionally verify a LAN/loopback registry.
    // The multi-tenant control plane must never let an org admin use this probe
    // to reach its private network. safeFetch also pins DNS and re-validates
    // every redirect before connecting.
    allowHttp: !env.CLOUD_MODE,
    allowPrivate: !env.CLOUD_MODE,
    maxRedirects: 3,
  });
}

/**
 * The registry a `docker.io` credential must actually be checked against.
 *
 * `docker.io` is the name in an image reference, not a host that serves the v2 API —
 * requests go to `registry-1.docker.io`. Verifying against `docker.io` itself fails for
 * reasons that have nothing to do with the credential.
 */
function verifyHostFor(registry: string): string {
  return registry === DOCKER_HUB_REGISTRY ? "registry-1.docker.io" : registry;
}

/**
 * Container registry, via the Distribution v2 handshake.
 *
 * `GET /v2/` is the standard capability probe. Three answers matter:
 *   200 — the registry accepted us (with or without needing the credential).
 *   401 + `WWW-Authenticate: Bearer realm=…` — the modern flow: exchange basic auth at
 *         the realm for a token. This is what ghcr.io, Docker Hub and ECR do, and it is
 *         the only step that actually proves the credential.
 *   401 + `WWW-Authenticate: Basic` — older registries: retry /v2/ with basic auth.
 */
const verifyDockerRegistry: Verifier = async ({ selector, publicFields, secrets }) => {
  const registry = selector;
  if (!registry) return { ok: false, reason: "No registry host was given." };
  const username = publicFields.username ?? "";
  const password = secrets.secret ?? "";
  if (!username || !password) return { ok: false, reason: "Username and secret are required." };

  const basic = Buffer.from(`${username}:${password}`).toString("base64");
  const host = verifyHostFor(registry);
  // http only for a loopback registry, which cannot have a public certificate.
  const scheme = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? "http" : "https";
  const base = `${scheme}://${host}`;

  let probe: SafeFetchResponse;
  try {
    probe = await fetchWithTimeout(`${base}/v2/`);
  } catch (err) {
    // The message here is ours, not the fetch layer's: a DNS/TLS error string can contain
    // the full URL, which for some registries embeds the account.
    const detail = safeErrorMessage(err).toLowerCase();
    const why =
      detail.includes("aborted") || detail.includes("timed out")
        ? "timed out"
        : "could not be reached";
    return {
      ok: false,
      reason: `${registry} ${why}. Check the host and that this machine can reach it.`,
    };
  }

  if (probe.status === 200) {
    // The registry answered without demanding auth. The credential is unproven — but it
    // is also unnecessary here, and refusing to store it would be wrong for a registry
    // that only requires auth on private repositories.
    return { ok: true };
  }

  const challenge = probe.headers["www-authenticate"] ?? "";

  if (/^bearer/i.test(challenge)) {
    const realm = /realm="([^"]+)"/i.exec(challenge)?.[1];
    const service = /service="([^"]+)"/i.exec(challenge)?.[1];
    if (!realm) return { ok: false, reason: `${registry} asked for a token but named no realm.` };
    const url = new URL(realm);
    if (service) url.searchParams.set("service", service);
    // No `scope`: an empty scope yields a token proving only authentication, which is
    // exactly what is being verified. Asking for a repository scope would fail for a
    // valid credential that simply cannot see the repository we invented.
    try {
      const token = await fetchWithTimeout(url.toString(), {
        authorization: `Basic ${basic}`,
      });
      if (token.status === 200) return { ok: true };
      if (token.status === 401 || token.status === 403) {
        return { ok: false, reason: `${registry} rejected these credentials.` };
      }
      return { ok: false, reason: `${registry} answered ${token.status} when issuing a token.` };
    } catch {
      return { ok: false, reason: `${registry}'s token endpoint could not be reached.` };
    }
  }

  if (/^basic/i.test(challenge)) {
    try {
      const authed = await fetchWithTimeout(`${base}/v2/`, {
        authorization: `Basic ${basic}`,
      });
      if (authed.status === 200) return { ok: true };
      return { ok: false, reason: `${registry} rejected these credentials.` };
    } catch {
      return { ok: false, reason: `${registry} could not be reached.` };
    }
  }

  return {
    ok: false,
    reason: `${registry} answered ${probe.status} and did not offer a login method Openship understands.`,
  };
};

/**
 * Cloudflare, via the token self-verify endpoint.
 *
 * Deliberately the same check the DNS provider's own preflight makes, so a token stored
 * here behaves identically to one stored the old way. Reusing that module directly would
 * pull the whole DNS provider graph into settings; this is one documented request.
 */
const verifyCloudflare: Verifier = async ({ secrets }) => {
  const apiToken = secrets.apiToken ?? "";
  if (!apiToken) return { ok: false, reason: "An API token is required." };
  try {
    const res = await fetchWithTimeout("https://api.cloudflare.com/client/v4/user/tokens/verify", {
      authorization: `Bearer ${apiToken}`,
    });
    if (res.status === 200) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: "Cloudflare rejected this token." };
    }
    return { ok: false, reason: `Cloudflare answered ${res.status}.` };
  } catch {
    return { ok: false, reason: "Cloudflare could not be reached." };
  }
};

const VERIFIERS: Record<string, Verifier> = {
  "docker-registry": verifyDockerRegistry,
  cloudflare: verifyCloudflare,
};

/** True when this provider can be checked — a provider without one cannot be stored. */
export function hasVerifier(providerId: string): boolean {
  return providerId in VERIFIERS;
}

export async function verifyCredentialValues(
  provider: CredentialProvider,
  args: {
    selector: string | null;
    publicFields: Record<string, string>;
    secrets: CredentialSecrets;
  },
): Promise<VerifyResult> {
  const verifier = VERIFIERS[provider.id];
  if (!verifier) {
    return { ok: false, reason: `Openship cannot verify ${provider.label} credentials yet.` };
  }
  try {
    return await verifier(args);
  } catch (err) {
    // A verifier bug must not be reported as "your credential is bad".
    return { ok: false, reason: `Verification failed unexpectedly: ${safeErrorMessage(err)}` };
  }
}
