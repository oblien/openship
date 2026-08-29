/**
 * Env keys a project must not be able to set on a running workload, shared by
 * every runtime that materializes one.
 *
 * `PATH` is the whole list, and it is a correctness gate rather than a
 * preference. Our own Dockerfile generator bakes `node_modules/.bin` into the
 * runtime stage's `ENV PATH`, and the bare/cloud start commands prepend the same
 * dirs as a shell prelude, so that a dependency-binary start command
 * (`next start`, `gatsby serve`) resolves at all — openship#623. But none of the
 * transports that carry a project's env do variable expansion:
 *
 *   - docker `Env`      — an absolute literal; REPLACES the image's `ENV PATH`
 *   - oblien workload   — same
 *   - systemd `Environment=` — no `$PATH` expansion, so it replaces, not extends
 *   - nohup `export`    — emitted BEFORE the start command, so it wins the base
 *
 * A project that sets PATH (almost always by copying a value out of another
 * platform) therefore deletes the entry the build just went to trouble to add,
 * and the app exits 127 at runtime with a completely green build log. Nothing
 * upstream rejects the key either: the env-merge endpoints bound only count and
 * length, and the only pre-existing PATH denylist is migration-import-only.
 *
 * Deliberately ONE list for all four surfaces. The bug this guards against was
 * itself created by the same fix landing on some surfaces and not others.
 */
export const RUNTIME_ENV_EXCLUDES: ReadonlySet<string> = new Set(["PATH"]);

/**
 * Split a project env map into the entries a runtime may pass through and the
 * keys it must drop. Insertion order is preserved: docker resolves a repeated
 * key last-one-wins, and callers prepend their own `PORT`/`NODE_ENV` ahead of
 * these.
 *
 * `dropped` is returned rather than swallowed so a caller with a log surface can
 * say so — the operator typed the key by hand, and silently ignoring it is how
 * they end up debugging a 127 that has no explanation anywhere in the product.
 */
export function splitRuntimeEnv(envVars: Record<string, string>): {
  entries: [string, string][];
  dropped: string[];
} {
  const entries: [string, string][] = [];
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(envVars)) {
    if (RUNTIME_ENV_EXCLUDES.has(key)) dropped.push(key);
    else entries.push([key, value]);
  }
  return { entries, dropped };
}

/** One-line operator-facing explanation for a dropped key, or "" when none were. */
export function droppedRuntimeEnvMessage(dropped: string[]): string {
  if (dropped.length === 0) return "";
  return (
    `Ignoring ${dropped.join(", ")} from this project's environment: it would replace the ` +
    `runtime's own value and stop the start command from resolving. Remove it to silence this.\n`
  );
}
