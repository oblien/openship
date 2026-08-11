/**
 * What a rollback would do to the project's environment — keys only.
 *
 * A rollback replays the env frozen with the target release, and that snapshot
 * WINS over today's rows (`frozenEnvWins` in compose/deploy.service.ts). That is
 * the right default — "old code, new config" is a combination nobody ever ran —
 * but it means a rollback can quietly revert a rotated secret. This diff is the
 * mitigation: the confirm dialog shows which keys change and in which direction
 * before the operator commits.
 *
 * VALUES ARE NEVER EMITTED. Env is output-masked everywhere else behind a
 * write-gated reveal endpoint; a confirm dialog is not the place to widen that.
 * Callers decrypt both sides in memory only to answer "same or different".
 */

/** How the frozen snapshot reaches the containers. */
export type EnvRestoreStrategy =
  /** Compose: frozen values are layered LAST over live env — matching keys are
   *  shadowed, keys the snapshot never captured stay as they are today. */
  | "overlay"
  /** Single-app: the release's env map is used verbatim, so keys added since are
   *  absent after the restore. */
  | "replace"
  /** Unit swap: the existing container is restarted, never recreated, so its
   *  environment is not re-derived at all. */
  | "unchanged";

export type EnvChangeDirection =
  /** In both, with a different value: the release's value comes back. */
  | "frozen-wins"
  /** Only in the release: the restore re-introduces a key deleted since. */
  | "removed-since"
  /** Only in today's env: added after this release was captured. Kept under
   *  `overlay`, dropped under `replace`. */
  | "added-since";

export interface EnvChange {
  key: string;
  direction: EnvChangeDirection;
  /**
   * The live value is defined per-service (a service-scoped env row, or inline
   * `environment:` in compose) while the frozen capture is one flat unscoped map
   * (`meta.envCapture === "flat-v1"`). Replaying it applies ONE value to EVERY
   * service — the one case the flat capture cannot resolve correctly.
   */
  scopeAmbiguous?: boolean;
  /** Set when exactly one service defines the live value. */
  serviceName?: string;
}

export interface EnvDiff {
  strategy: EnvRestoreStrategy;
  /** Ranked most-consequential first, then capped. */
  changes: EnvChange[];
  /** Total before the cap — the dialog shows this, not `changes.length`. */
  totalChanges: number;
  truncated: boolean;
}

export interface EnvDiffInput {
  /** DECRYPTED `dep.envVars` for the release being restored. */
  frozen: Record<string, string>;
  /** DECRYPTED project-scoped (serviceId IS NULL) env for that environment. */
  liveProject: Record<string, string>;
  /**
   * Per-service overrides as they resolve today: inline compose `environment:`
   * merged under the service's own env rows (rows win, matching the deploy
   * merge). Empty for a single-app project.
   */
  liveServices?: Array<{ name: string; overrides: Record<string, string> }>;
  strategy: EnvRestoreStrategy;
  /** Default 200. */
  cap?: number;
}

export const ENV_DIFF_CAP = 200;

const RANK: Record<EnvChangeDirection, number> = {
  "frozen-wins": 0,
  "removed-since": 1,
  "added-since": 2,
};

export function diffFrozenEnv(input: EnvDiffInput): EnvDiff {
  const cap = input.cap ?? ENV_DIFF_CAP;
  const services = input.liveServices ?? [];

  if (input.strategy === "unchanged") {
    return { strategy: "unchanged", changes: [], totalChanges: 0, truncated: false };
  }

  const keys = new Set<string>([
    ...Object.keys(input.frozen),
    ...Object.keys(input.liveProject),
    ...services.flatMap((s) => Object.keys(s.overrides)),
  ]);

  const changes: EnvChange[] = [];
  for (const key of keys) {
    const inFrozen = key in input.frozen;
    const definedBy = services.filter((s) => key in s.overrides);
    const inLive = key in input.liveProject || definedBy.length > 0;

    let direction: EnvChangeDirection;
    if (!inFrozen) {
      direction = "added-since";
    } else if (!inLive) {
      direction = "removed-since";
    } else {
      // Compare against every value this key resolves to today. A service that
      // has no definition at all counts as different: the frozen value would be
      // introduced there. With no services, the project value is the only one.
      const effective =
        services.length > 0
          ? services.map((s) => s.overrides[key] ?? input.liveProject[key])
          : [input.liveProject[key]];
      if (effective.every((value) => value === input.frozen[key])) continue;
      direction = "frozen-wins";
    }

    const change: EnvChange = { key, direction };
    if (inFrozen && definedBy.length > 0) change.scopeAmbiguous = true;
    if (definedBy.length === 1) change.serviceName = definedBy[0].name;
    changes.push(change);
  }

  changes.sort((a, b) => RANK[a.direction] - RANK[b.direction] || a.key.localeCompare(b.key));

  return {
    strategy: input.strategy,
    // Ranked BEFORE the cap, so truncation drops the least consequential rows —
    // a cap that hid a reverted secret would defeat the point of the dialog.
    changes: changes.slice(0, cap),
    totalChanges: changes.length,
    truncated: changes.length > cap,
  };
}
