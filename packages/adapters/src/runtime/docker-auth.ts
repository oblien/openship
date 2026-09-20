/**
 * Registry credentials for a LOCAL Docker Engine pull.
 *
 * dockerode does not read `~/.docker/config.json` — the Docker CLI does. So a pull
 * issued through the API's own daemon connection went out anonymous even on a host
 * that was `docker login`-ed, and every private-image deploy failed with an
 * unauthorized manifest fetch (#581).
 *
 * SCOPE: local daemon only. An SSH-executor pull shells out to `docker pull` on the
 * REMOTE host, which reads that host's own credentials — so nothing here runs for a
 * remote pull, and local credentials are never read for, or transferred to, another
 * machine.
 *
 * WHAT THIS CANNOT DO. Docker CLI can keep credentials in an external helper
 * (`credsStore`/`credHelpers` → `docker-credential-desktop`, `-pass`,
 * `-secretservice`, `-osxkeychain`). Those are host binaries with host-side state;
 * the API image ships none of them and could not reach their backing store from a
 * container even if it did. When a registry's credential lives in a helper we
 * therefore fail with an actionable message instead of silently pulling anonymously
 * and reporting the resulting 401 as a missing image.
 *
 * THAT FAILURE MUST STAY NARROW, and this is the subtlety worth reading twice: it
 * applies only when the registry we are pulling FROM is helper-backed. A global
 * `credsStore` is set on most developer machines (Docker Desktop writes
 * `"credsStore": "desktop"` by default) and says nothing about whether the image we
 * want needs credentials at all. Treating its mere presence as fatal turns every
 * anonymous pull of a public image — `postgres:16-alpine`, `redis:7-alpine` — into a
 * hard failure on a machine where it worked before.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type Dockerode from "dockerode";

import { registryConfigKeys, registryForImage } from "@repo/core";

type DockerAuthEntry = {
  auth?: string;
  identitytoken?: string;
  username?: string;
  password?: string;
};

type DockerConfig = {
  auths?: Record<string, DockerAuthEntry>;
  credHelpers?: Record<string, string>;
  credsStore?: string;
};

function firstPresent<T>(
  values: Record<string, T> | undefined,
  keys: string[],
): { key: string; value: T } | undefined {
  if (!values) return undefined;
  for (const key of keys) {
    if (Object.hasOwn(values, key)) return { key, value: values[key]! };
  }
  return undefined;
}

export { registryForImage };

/**
 * What a pull sends as `authconfig`.
 *
 * Aliased here so a caller — including the API, which supplies these from the database —
 * can type a resolver without importing dockerode itself.
 */
export type DockerRegistryAuth = Dockerode.AuthConfig;

/**
 * A minimal `~/.docker/config.json` body carrying exactly one registry's credential, for
 * handing to a `docker`/`docker compose` command via `DOCKER_CONFIG`.
 *
 * Scoped to the ONE registry being pulled from, deliberately: a config holding every
 * credential the org has would be written to a remote host to fetch a single image.
 *
 * Returns null when there is nothing usable — no key to file it under, or neither an
 * identity token nor a complete username/password pair. A half credential makes the
 * registry answer 401, which reads as "wrong password" rather than "incomplete record".
 */
export function dockerConfigJsonFor(auth: DockerRegistryAuth): string | null {
  const a = auth as {
    serveraddress?: string;
    username?: string;
    password?: string;
    identitytoken?: string;
  };
  const registry = a.serveraddress?.trim();
  if (!registry) return null;

  if (a.identitytoken) {
    return JSON.stringify({ auths: { [registry]: { identitytoken: a.identitytoken } } });
  }
  if (!a.username || !a.password) return null;
  const encoded = Buffer.from(`${a.username}:${a.password}`).toString("base64");
  return JSON.stringify({ auths: { [registry]: { auth: encoded } } });
}

/** An inline entry that actually carries usable material. */
function toAuthConfig(
  entry: DockerAuthEntry,
  serveraddress: string,
): Dockerode.AuthConfig | undefined {
  if (entry.identitytoken) {
    return { identitytoken: entry.identitytoken, serveraddress } as Dockerode.AuthConfig;
  }
  if (entry.username && entry.password) {
    return { username: entry.username, password: entry.password, serveraddress };
  }
  if (!entry.auth) return undefined;

  let decoded: string;
  try {
    decoded = Buffer.from(entry.auth, "base64").toString("utf8");
  } catch {
    return undefined;
  }
  const separator = decoded.indexOf(":");
  // A username may not be empty and the password may not be absent; `base64("x")`
  // decodes fine but is not a credential.
  if (separator < 1) return undefined;
  return {
    username: decoded.slice(0, separator),
    password: decoded.slice(separator + 1),
    serveraddress,
  };
}

/** Raised when a registry's credential exists but lives somewhere unreachable. */
export class DockerCredentialHelperError extends Error {
  constructor(registry: string) {
    // Names neither the helper nor the config path: the helper's name identifies the
    // operator's credential tooling, and this string reaches deploy logs.
    super(
      `Openship can't read the credentials for ${registry}: they are stored in a Docker ` +
        `credential helper, which is not available inside the Openship container. ` +
        `Add the credentials inline to the Docker config (docker logout ${registry}, ` +
        `remove the credential helper for it, then docker login ${registry}), or use a ` +
        `public image.`,
    );
    this.name = "DockerCredentialHelperError";
  }
}

/**
 * Credentials to send with a local pull of `ref`, or `undefined` to pull anonymously.
 *
 * Never throws for an absent or unreadable config — a host with no Docker login is
 * the normal case and must keep pulling public images. Throws only
 * {@link DockerCredentialHelperError}, and only when THIS registry's credential is
 * held by a helper we cannot run.
 */
export async function resolveDockerAuth(
  ref: string,
): Promise<Dockerode.AuthConfig | undefined> {
  const registry = registryForImage(ref);
  const configPath = join(
    process.env.DOCKER_CONFIG || join(homedir(), ".docker"),
    "config.json",
  );

  let config: DockerConfig;
  try {
    config = JSON.parse(await readFile(configPath, "utf8")) as DockerConfig;
  } catch {
    // Missing, unreadable or malformed: there is nothing to authenticate WITH, which
    // is not the same as being forbidden to pull. A public image must still work, and
    // a private one fails at the daemon with the registry's own 401 — a clearer
    // signal than a config error the operator may not even know applies.
    return undefined;
  }
  if (!config || typeof config !== "object") return undefined;

  const keys = registryConfigKeys(registry);
  const inline = firstPresent(config.auths, keys);
  const usable = inline ? toAuthConfig(inline.value, inline.key) : undefined;
  if (usable) return usable;

  // No usable inline material. Would a helper have supplied it?
  //   • credHelpers names a helper for THIS registry → yes, definitively.
  //   • a global credsStore, AND this registry has an auths entry → yes: `docker
  //     login` records the registry in `auths` with the secret moved to the store,
  //     which is exactly the shape we see here (entry present, nothing usable in it).
  // Anything else means no credential is configured for this registry, so pull
  // anonymously — the case that keeps public images working on a machine with a
  // credsStore set.
  const helperForRegistry = firstPresent(config.credHelpers, keys);
  if (helperForRegistry || (config.credsStore && inline)) {
    throw new DockerCredentialHelperError(registry);
  }
  return undefined;
}
