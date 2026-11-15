/**
 * Builder selection for the dockerode (Engine API) build path.
 *
 * Three modes, resolved once per build from `OPENSHIP_BUILDER_MODE`:
 *
 *   auto     (default) — BuildKit only when the Dockerfile needs it
 *                        (RUN --mount, a syntax directive, a heredoc), with an
 *                        automatic fallback to the classic builder when the
 *                        daemon cannot serve BuildKit's `/session` endpoint.
 *   classic  — never send `version=2`. For OCI-compatible daemons that
 *             implement the Engine API but not dockerd's embedded BuildKit
 *             (Podman's compat socket is the common case).
 *   buildkit — always send `version=2`, even for a plain Dockerfile.
 *
 * The two explicit pins are honoured verbatim — no fallback: a silent switch
 * under `buildkit` would change the build's resource semantics (the classic
 * builder enforces Engine API memory caps BuildKit ignores), so a pinned
 * build fails with the daemon's own error instead. Resilience belongs to
 * `auto`.
 *
 * Why a fallback belongs here rather than in the caller's error handling:
 * BuildKit-over-API needs TWO things dockerd happens to provide and other
 * daemons don't — the `/session` reverse-h2c endpoint (credentials) and the
 * `version=2` build path itself. A daemon that 404s `/session` fails the build
 * BEFORE the first layer compiles, with an error that names neither BuildKit
 * nor a fix ("docker /session failed: 404"). Falling back to the classic
 * builder turns that into a slower-but-correct build plus one warning line.
 *
 * The mode is deliberately NOT a per-project setting: which builder a daemon
 * can serve is a property of the DAEMON, not of the image being built.
 */

/** Env var that overrides builder selection for the Engine API path. */
export const DOCKER_BUILDER_MODE_ENV = "OPENSHIP_BUILDER_MODE";

export type DockerodeBuilderMode = "auto" | "classic" | "buildkit";

export function resolveDockerodeBuilderMode(
  raw: string | undefined = process.env[DOCKER_BUILDER_MODE_ENV],
): DockerodeBuilderMode {
  const value = raw?.trim().toLowerCase();
  return value === "classic" || value === "buildkit" ? value : "auto";
}

/**
 * Did this build failure mean "the daemon has no BuildKit session endpoint"?
 *
 * Podman (any 5.x) implements the Docker compat API but not `/session` — that
 * endpoint lives in dockerd's embedded buildkit. The failure surfaces before
 * the build starts, either from OpenShip's own raw-upgrade path
 * ("docker /session failed: HTTP/1.1 404 Not Found — Not Found", via
 * docker-exec-stream's upgradeRequest — it interpolates the FULL status line,
 * HTTP version included, so the matcher must tolerate the `HTTP/1.1 ` between
 * `failed: ` and the code; verified live against Podman 5.8.2's compat socket)
 * or, on a stock-node dockerode, as the modem's `(HTTP code 404)` dial error.
 * Both shapes are matched narrowly: a 404 on a DIFFERENT endpoint must never
 * demote a build to the classic builder.
 */
export function isBuildKitSessionUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message;
  // The optional `HTTP/<ver> ` covers the real status line; the bare `40x` arm
  // tolerates a body-less/normalized shape. 405 included: some proxies answer
  // an unsupported upgrade with it.
  if (/docker \/session failed: (?:HTTP\/[\d.]+ )?40[45]\b/.test(message)) return true;
  return /\(HTTP code 404\)/i.test(message) && /\bsession\b/i.test(message);
}

// ── Daemon BuildKit capability probe ─────────────────────────────────────────
//
// The /session fallback above is reactive: the BuildKit attempt goes out, 404s,
// gets aborted, and the classic retry ships on whatever connection the aborted
// upload left behind. On Podman that connection delivers an EMPTY build context
// ("stat /var/tmp/libpod_builder<N>/build/Dockerfile: no such file or
// directory" — Podman 5.8.2, verified live), because aborting a chunked upload
// mid-flight leaves the pooled keep-alive socket unreadable at one end.
//
// Probing GET /version once per daemon turns that into a proactive decision:
// a daemon that answers "Podman" never gets the doomed BuildKit attempt at
// all. The reactive fallback stays as the net for daemons the probe can't
// classify (probe failure, dockerd genuinely without buildkit, …).

/** Cache: daemon identity → GET /version payload (null when the probe failed). */
const daemonVersionByDaemon = new Map<string, unknown>();

/** Test hook — the cache is per-process state. */
export function resetDaemonBuildKitProbeCache(): void {
  daemonVersionByDaemon.clear();
}

/** Structural modem view — keeps this module free of a dockerode import. */
interface DaemonModemView {
  socketPath?: unknown;
  host?: unknown;
  port?: unknown;
}

/**
 * Stable per-daemon cache key from a docker-modem's connection coordinates.
 * Null when the modem doesn't describe a daemon we can name (SSH-composited
 * modems, cloud bridges without a stable address) — the caller then keeps the
 * reactive fallback.
 */
export function daemonProbeCacheKey(modem: DaemonModemView | null | undefined): string | null {
  if (!modem || typeof modem !== "object") return null;
  if (typeof modem.socketPath === "string" && modem.socketPath) return `unix:${modem.socketPath}`;
  if (typeof modem.host === "string" && modem.host) {
    return `tcp:${modem.host}:${typeof modem.port === "number" || typeof modem.port === "string" ? modem.port : ""}`;
  }
  return null;
}

/**
 * Does a GET /version payload describe Podman's Docker-compatible API?
 *
 * Podman reports itself in `Components[].Name` ("Podman Engine") and/or
 * `Platform.Name` ("Podman Engine …" / "linux … podman"); dockerd reports
 * "Docker Engine". String-contains on /podman/i is deliberately loose — the
 * consequence of a false positive is only the reactive fallback still working.
 */
export function isPodmanDaemon(version: unknown): boolean {
  if (!version || typeof version !== "object") return false;
  const v = version as { Platform?: { Name?: unknown }; Components?: Array<{ Name?: unknown }> };
  const platformName = typeof v.Platform?.Name === "string" ? v.Platform.Name : "";
  if (/podman/i.test(platformName)) return true;
  return (v.Components ?? []).some((c) => typeof c?.Name === "string" && /podman/i.test(c.Name));
}

/**
 * Does this daemon serve dockerd's embedded BuildKit (`/session`)? Probed once
 * per daemon per process. `null` = couldn't tell (probe failed) — callers keep
 * the reactive two-attempt fallback.
 */
export async function daemonSupportsBuildKitSession(
  key: string,
  fetchVersion: () => Promise<unknown>,
): Promise<boolean | null> {
  if (!daemonVersionByDaemon.has(key)) {
    try {
      daemonVersionByDaemon.set(key, await fetchVersion());
    } catch {
      // Unreachable daemon mid-probe is not a build verdict; don't cache a
      // failure as a capability. The build itself will surface the error if
      // the daemon is truly gone.
      // diagnostics-ignore: probe failure is deliberately not a cached verdict
      return null;
    }
  }
  const version = daemonVersionByDaemon.get(key);
  if (version == null) return null;
  return !isPodmanDaemon(version);
}

/**
 * "podman" | "docker" for the daemon behind `key`, from the SAME cached
 * GET /version payload the BuildKit probe uses — so a build logs the engine it
 * talks to at no extra probe cost, and the BuildKit decision below reads the
 * payload this call already fetched. undefined = the probe failed or returned
 * nothing usable; callers keep the Docker wording (still true of the API
 * surface they speak, which is what the surrounding steps name).
 */
export async function daemonEngineName(
  key: string,
  fetchVersion: () => Promise<unknown>,
): Promise<"docker" | "podman" | undefined> {
  if (!daemonVersionByDaemon.has(key)) {
    try {
      daemonVersionByDaemon.set(key, await fetchVersion());
    } catch {
      // Same policy as the BuildKit probe: a failed probe is not a verdict.
      return undefined;
    }
  }
  const version = daemonVersionByDaemon.get(key);
  if (version == null) return undefined;
  return isPodmanDaemon(version) ? "podman" : "docker";
}
