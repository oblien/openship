import { getGitProvider } from "./provider";
import type { BuildGitCredential, GitCloneOptions } from "./clone-types";

export function resolveBuildGitCredentials(
  provider: string,
  options: GitCloneOptions,
): Promise<BuildGitCredential> {
  return getGitProvider(provider).resolveCloneCredentials(options);
}

/**
 * Can a clone run ON THE BUILD HOST with this credential, or must it fall back to cloning on the
 * orchestrator and shipping the context?
 *
 * ONE definition, because two would drift into a deploy that falls back while the UI promised it
 * wouldn't. It lived inline in `build-pipeline` as an unnamed boolean, which meant the only way to
 * find out whether "On the server" would actually work was to start a deploy and read the log.
 *
 * Five things qualify, and the reasons they do are not interchangeable:
 *   - `ambient`   — the server already has its own git access; nothing needs to move.
 *   - `ssh`       — a key we can ship and use there (server key or per-repo deploy key).
 *   - `relay`     — the desktop relay forwards the identity for the duration.
 *   - `anonymous` — a public repo needs no credential at all.
 *   - `token` WITHOUT `apiHostFallback` — an App/PAT usable off-host. The flag is the whole
 *     point: a token carrying it is a LOCAL credential for cloning on THIS host, so treating
 *     token-presence alone as "shippable" would send a credential somewhere it can't authenticate
 *     and leak it off-host on the way.
 *
 * The BARE runtime always clones on the target and is gated by preflight separately, so callers
 * apply this to the docker runtime only.
 */
export function cloneOnServerAvailable(
  // The REAL credential type, not a hand-written subset: `ambient` is an object (`{ via }`), and
  // a structural copy that guessed `boolean` typechecked while reading the same field.
  cred: Pick<
    BuildGitCredential,
    "ambient" | "relay" | "ssh" | "anonymous" | "token" | "apiHostFallback"
  >,
): { available: true } | { available: false; reason: string } {
  if (cred.ambient) return { available: true };
  if (cred.relay === true) return { available: true };
  if (cred.ssh) return { available: true };
  if (cred.anonymous === true) return { available: true };
  if (cred.token && !cred.apiHostFallback) return { available: true };
  return {
    available: false,
    reason:
      "the server has no Git identity of its own, no App/PAT token is available, and no git " +
      "identity could be forwarded",
  };
}
