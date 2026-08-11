/**
 * "The edge container isn't up" — said once, in words an operator can act on.
 *
 * Every command that touches the edge (`openresty -t`, `-s reload`, `certbot`,
 * every vhost read/write in container-file mode) runs as a `docker exec` into the
 * edge container. When that container is crash-looping, the daemon refuses the exec
 * and the caller gets the daemon's own sentence, which names the RESOLVED 64-hex id
 * and nothing else:
 *
 *   Error response from daemon: Container b8968804d6a7…d5771c7 is restarting, wait
 *   until the container is running
 *
 * That is the worst possible message for the situation. It names no container an
 * operator recognises, gives no cause, and — surfaced from the cert flow of a STATIC
 * project, which has no container of its own — reads as if we went looking for a
 * container that was never supposed to exist. (We didn't: static sites are served by
 * the edge from the shared static volume, and certbot's standalone authenticator
 * runs inside the edge because the edge is what proxies the challenge to it.)
 *
 * The cause is always available and was never fetched: a crash-looping OpenResty
 * writes exactly one explanatory line, its `[emerg]`, to `docker logs`.
 * `edgeCrashReason`/`edgeFailureReason` have existed for that since the container
 * edge shipped, wired into the proxy CLI and the edge installer — but not into any
 * of the exec paths, which are where operators actually meet the failure.
 *
 * Pure string work here, no executor: the two transports fetch that log through
 * completely different channels (a shell `docker logs` over SSH; dockerode's log API
 * over the socket) and only the WORDING is common. Same split, same reason, as
 * `edgeFailureReason` itself.
 */

/**
 * The phrase every message from {@link explainEdgeDown} contains, and the only
 * thing {@link edgeDownExplanation} matches on.
 *
 * A marker rather than prose-matching because these messages travel as plain
 * strings — through `routeWarnings` into `deployWarning`, through certbot's failure
 * summarizer — and each of those consumers has to be able to ask "is this an
 * edge-down failure?" without re-deriving the vocabulary. Producer and classifier
 * share this constant so they cannot drift.
 */
export const EDGE_DOWN_MARKER = "the edge container is not running";

/**
 * Does this failure text mean the edge container wasn't up to receive the command?
 *
 * Deliberately NARROW — matched only against strings the Docker daemon and nginx
 * produce for exactly this condition, never "the command exited non-zero". Every
 * failed exec would otherwise pay two extra round-trips (`docker inspect` +
 * `docker logs`) for enrichment, and failed execs are ROUTINE on a healthy box:
 * `test -e` reports a missing path by exit code, and the container-file probes lean
 * on that.
 *
 * `invalid PID number` earns its place next to the daemon's own strings even though
 * it comes out of nginx: the container runs `openresty -g "daemon off;"` as PID 1, so
 * a reload that finds an EMPTY pid file has landed in the window where the master is
 * already gone and the container has not yet been restarted. It reads like a config
 * problem (it arrives right after "configuration file … test is successful") and is
 * in fact the same crash loop, one moment earlier.
 */
export function isEdgeDownFailure(text: string): boolean {
  return (
    /is restarting, wait until the container is running/i.test(text) ||
    /container .* is not running/i.test(text) ||
    /\bis not running\b/i.test(text) ||
    /No such container/i.test(text) ||
    /container .* is paused/i.test(text) ||
    /invalid PID number/i.test(text)
  );
}

/**
 * The operator-facing sentence. ONE line, no newlines — it has to survive being
 * joined into a deploy warning with `; ` and being handed to certbot's summarizer,
 * whose "last three lines" fallback would otherwise shred a paragraph into
 * fragments.
 *
 * `status` is the container's own `.State.Status` when we could read it, and it is
 * what distinguishes the two cases worth telling apart: `restarting` is a crash loop
 * that will keep failing, while `exited`/`created` is something that simply needs
 * starting.
 */
export function explainEdgeDown(opts: {
  container: string;
  /** `docker inspect -f '{{.State.Status}}'`, when it could be read. */
  status?: string | null;
  /** The `[emerg]` line from the container's log — {@link edgeFailureReason}. */
  reason?: string | null;
}): string {
  const { container, status, reason } = opts;
  const state = status?.trim() ? ` (${status.trim()})` : "";
  const crashLooping = status?.trim() === "restarting";

  const consequence = crashLooping
    ? `it is crash-looping, so nothing that runs through the edge on this server can work — ` +
      `certificate issuance, config reloads and route changes all go through it`
    : `nothing that runs through the edge on this server can work until it is up — ` +
      `certificate issuance, config reloads and route changes all go through it`;

  const cause = reason?.trim()
    ? `OpenResty is refusing to start: ${reason.trim().replace(/\s+/g, " ")}. Fix that, then ` +
      `\`docker start ${container}\` and retry.`
    : `Run \`docker logs --tail 40 ${container}\` on the server for the reason, then retry.`;

  return `${EDGE_DOWN_MARKER} ("${container}")${state} — ${consequence}. ${cause}`;
}

/**
 * Pull our explanation back out of a blob that may also contain the daemon's
 * original error, certbot's opener, or a streamed reload transcript. Returns null
 * when there isn't one.
 *
 * This is what lets a downstream consumer that only ever sees a string — the certbot
 * failure summarizer, the deploy pipeline's routing warning — recognise the
 * condition and stop applying its own (wrong) lens to it.
 */
export function edgeDownExplanation(text: string): string | null {
  if (!text) return null;
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.includes(EDGE_DOWN_MARKER));
  return line || null;
}

/**
 * Is this text an edge-down failure, whether or not it has been explained yet?
 * For callers choosing what ADVICE to print — "fix DNS/routing and retry" is
 * actively misleading when the edge is the thing that's down.
 */
export function isEdgeDownMessage(text: string): boolean {
  return !!text && (!!edgeDownExplanation(text) || isEdgeDownFailure(text));
}
