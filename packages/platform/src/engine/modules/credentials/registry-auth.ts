/**
 * Registry credentials for an image pull, from Openship's own credential store.
 *
 * THE ONE ISSUER for image-pull auth, in the same spirit as `resolveBuildGitToken` is for
 * git: every pull path asks this, so there is a single place where precedence, redaction
 * and the "which registry does this reference address" question are answered.
 *
 * The adapter cannot do this itself — the answer is in the database, and
 * `packages/adapters` must not import `@repo/db`. So the API builds a closure and hands it
 * to the runtime through `DockerConnectionOptions.resolveRegistryAuth`, keeping credential
 * POLICY here and leaving the adapter knowing only how to talk to Docker.
 */

import { registryForImage, safeErrorMessage } from "@repo/core";
import type { DockerRegistryAuth } from "@repo/adapters";

import { resolveCredentialSecrets } from "./credential.service";

/**
 * Credentials to send with a pull of `ref`, or undefined to pull anonymously.
 *
 * The registry is derived with `registryForImage` — the SAME function
 * `normalizeCredentialSelector` runs the operator's input through when the credential is
 * saved, which is what makes a stored `ghcr.io` login match an `ghcr.io/org/img:tag` pull.
 *
 * Never throws. A pull must not fail because a credential lookup did: no credential and a
 * broken lookup both mean "try anonymously", and a genuinely private image then fails at
 * the daemon with the registry's own 401 — a clearer signal than an internal error.
 */
export async function resolveRegistryAuthFor(opts: {
  organizationId: string;
  ref: string;
}): Promise<DockerRegistryAuth | undefined> {
  try {
    const registry = registryForImage(opts.ref);
    const found = await resolveCredentialSecrets({
      organizationId: opts.organizationId,
      provider: "docker-registry",
      selector: registry,
    });
    if (!found) return undefined;

    const username = found.publicFields.username;
    const secret = found.secrets.secret;
    if (!username || !secret) return undefined;

    // `serveraddress` is the registry as WE identify it. Docker uses it to pick the
    // credential for the manifest host, and a mismatch there is silently ignored rather
    // than reported, so it must be the same value the selector was normalized to.
    return { username, password: secret, serveraddress: registry };
  } catch (err) {
    console.warn(`[registry-auth] credential lookup failed: ${safeErrorMessage(err)}`);
    return undefined;
  }
}

/**
 * The closure form, for handing to a runtime at construction.
 *
 * Bound to one organization because that is the trust boundary: a runtime built for org A
 * must never be able to resolve org B's registry login, and binding it here means no call
 * site can pass the wrong id later.
 */
export function registryAuthResolver(
  organizationId: string,
): (ref: string) => Promise<DockerRegistryAuth | undefined> {
  return (ref) => resolveRegistryAuthFor({ organizationId, ref });
}
