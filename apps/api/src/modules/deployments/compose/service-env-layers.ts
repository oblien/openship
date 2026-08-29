/**
 * The env layering a compose/catalog service is deployed with.
 *
 * Its own module because THREE surfaces have to agree on it — the deploy merge,
 * the rollback confirm diff (`deployments/deployment.service.ts`), and anything
 * else reporting "what will this container get". Two of them used to spell the
 * rule out by hand, which is how the confirm dialog came to claim a precedence
 * the deploy no longer used. One rule, imported.
 */

import {
  resolveComposeEnvironmentTemplates,
  type ComposeMissingVariable,
} from "../../../lib/compose-parser";

/** The four env layers a compose service is deployed with, before token resolution. */
export interface ServiceEnvLayers {
  /**
   * Project-scoped rows, live.
   */
  project: Record<string, string>;
  /** This deployment's frozen capture (`dep.envVars`, decrypted). Flat, unscoped. */
  frozen: Record<string, string>;
  /** The compose file's inline `environment:` for this service. */
  inline: Record<string, string>;
  /** Names of inline values stored as their original Compose expressions. */
  templateKeys?: readonly string[];
  /** Service-scoped rows for this service, live. */
  service: Record<string, string>;
}

export interface MergedServiceEnv {
  /** The env the container is created with, before `{{publicUrl:…}}` resolution. */
  env: Record<string, string>;
  /**
   * Inline keys whose EMPTY value was not applied because a lower layer already
   * held a real one — see {@link inlineEmptyDefers}. NAMES ONLY, never values:
   * this is written to the deploy log, and env is output-masked everywhere else.
   *
   * Reported rather than swallowed for the same reason `resolveEnvPublicUrls`
   * reports what it omitted: silently rewriting a variable leaves no surface that
   * predicts the container. Both the service Env tab and the deploy wizard go on
   * displaying the empty value this merge decided to ignore.
   */
  deferredEmpty: string[];
  /** Required Compose variables still absent after every env layer was merged. */
  missingRequired: ComposeMissingVariable[];
}

/**
 * Whether an inline compose empty value yields to a value an earlier layer
 * already supplied.
 *
 * This is now a LEGACY-row fallback. Provenance-aware rows persist their raw
 * expressions plus `environmentTemplateKeys`; those are resolved after all env
 * layers exist, while an authored empty literal correctly remains empty. Rows
 * created before that marker cannot distinguish an unresolved passthrough from
 * an authored blank, so they retain the conservative issue-#614 behavior: an
 * empty inline value does not erase an already configured non-empty value.
 */
export function inlineEmptyDefers(
  inlineValue: string,
  alreadyLayered: string | undefined,
): boolean {
  // `!== undefined` is load-bearing: a passthrough key that appears in NO other
  // layer must still be set (to ""), not dropped. Omitting it would delete the
  // variable from the container instead of leaving it blank, which is a
  // different container than either reading of the compose file asked for.
  return inlineValue === "" && alreadyLayered !== undefined && alreadyLayered !== "";
}

/**
 * Layer a service's env. Service rows beat inline compose env beats project rows.
 * Raw Compose templates resolve after those layers exist, which lets an embedded
 * `${VAR}` consume a project- or service-scoped value. Only an unmarked legacy
 * empty value uses {@link inlineEmptyDefers}.
 *
 * `frozenWins` moves the frozen layer LAST, which is what makes a rollback replay
 * the release it restores instead of running old code against today's config —
 * the one combination nobody ever ran. It is layered last rather than used alone
 * because `dep.envVars` is flat and unscoped: it cannot express "this key was
 * never set here", so dropping the live layers would delete keys the snapshot
 * never captured. Last-wins shadows exactly the keys the release had.
 *
 * It shadows inline and service-scoped values too, which for a key that was
 * project-scoped at capture and is service-scoped now means one value lands on
 * every service. That case is unresolvable from a flat map, so it is surfaced per
 * key as `scopeAmbiguous` in the rollback confirm diff rather than hidden.
 *
 * Note the frozen layer is layered BEFORE inline on a normal deploy, so an empty
 * inline value defers to a frozen value as well as a project one. That is the
 * intent — the frozen capture is a snapshot of the operator's env, not of this
 * service's inline map — and it is why the deferral compares against the
 * accumulated result rather than against `layers.project`.
 */
export function mergeServiceDeployEnv(
  layers: ServiceEnvLayers,
  frozenWins: boolean,
): MergedServiceEnv {
  const env: Record<string, string> = { ...layers.project };
  const deferredEmpty: string[] = [];
  const templateKeys = new Set(layers.templateKeys ?? []);
  const hasTemplateProvenance = layers.templateKeys !== undefined;

  if (!frozenWins) Object.assign(env, layers.frozen);

  for (const [key, value] of Object.entries(layers.inline)) {
    // A template is evaluated after all layers exist, so it can consume a
    // service-scoped secret. Do not let its scan-time/raw representation become
    // part of the lookup first (especially for self-passthrough `${KEY}`).
    if (templateKeys.has(key)) continue;
    if (!hasTemplateProvenance && inlineEmptyDefers(value, env[key])) {
      deferredEmpty.push(key);
      continue;
    }
    env[key] = value;
  }

  // Explicit service-scoped rows win outright — including an empty one, which is
  // the supported way to force a variable blank on one service.
  Object.assign(env, layers.service);

  if (frozenWins) Object.assign(env, layers.frozen);

  const higherPriorityTemplateTargets = new Set(Object.keys(layers.service));
  if (frozenWins) {
    for (const key of Object.keys(layers.frozen)) higherPriorityTemplateTargets.add(key);
  }
  const templates = Object.fromEntries(
    [...templateKeys]
      .filter((key) => !higherPriorityTemplateTargets.has(key) && key in layers.inline)
      .map((key) => [key, layers.inline[key]!]),
  );
  const dynamic = resolveComposeEnvironmentTemplates(env, templates);

  // A key that a later layer supplied anyway was never really "deferred" —
  // reporting it would name a variable whose value this decision didn't pick.
  const decidedLater = (key: string) =>
    key in layers.service || (frozenWins && key in layers.frozen);
  return {
    env: dynamic.env,
    deferredEmpty: deferredEmpty.filter((key) => !decidedLater(key)),
    missingRequired: dynamic.missingRequired,
  };
}
