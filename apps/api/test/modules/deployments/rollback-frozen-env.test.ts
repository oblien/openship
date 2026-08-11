/**
 * A rollback replays the env frozen with the release it restores.
 *
 * Before this, the frozen layer beat live PROJECT env but lost to live SERVICE
 * env, so rolling back a compose project ran the old image against whatever the
 * service rows say today — "old code, new config", a combination that was never
 * deployed and never tested. The frozen layer now moves last on a rollback.
 *
 * The risk that buys is real: a rollback can revert a rotated secret. The
 * mitigation is `diffFrozenEnv`, which tells the operator which keys change and
 * in which direction BEFORE they commit — by key, never by value.
 */

import { describe, expect, it } from "vitest";

import {
  mergeServiceDeployEnv,
  resolveEnvPublicUrls,
} from "../../../src/modules/deployments/compose/deploy.service";
import { diffFrozenEnv, ENV_DIFF_CAP } from "../../../src/modules/deployments/rollback";

const layers = (over: Partial<Parameters<typeof mergeServiceDeployEnv>[0]> = {}) => ({
  project: {},
  frozen: {},
  inline: {},
  service: {},
  ...over,
});

describe("mergeServiceDeployEnv", () => {
  it("lets the frozen release beat a live SERVICE-scoped value on a rollback", () => {
    // The case that made rollback dishonest: the service row is the strongest
    // live layer, so a frozen snapshot that lost to it never actually replayed.
    const merged = mergeServiceDeployEnv(
      layers({
        project: { API_KEY: "project-live" },
        frozen: { API_KEY: "release" },
        inline: { API_KEY: "compose-inline" },
        service: { API_KEY: "service-live" },
      }),
      true,
    );
    expect(merged.API_KEY).toBe("release");
  });

  it("keeps service env winning on a normal deploy", () => {
    // Unchanged behaviour for every non-rollback deploy: the compose UI can still
    // override a global per service.
    const merged = mergeServiceDeployEnv(
      layers({
        project: { API_KEY: "project-live" },
        frozen: { API_KEY: "this-deploys-snapshot" },
        inline: { API_KEY: "compose-inline" },
        service: { API_KEY: "service-live" },
      }),
      false,
    );
    expect(merged.API_KEY).toBe("service-live");
  });

  it("does not delete keys the snapshot never captured", () => {
    // `dep.envVars` is flat and unscoped, so it cannot express "this key was
    // never set here". Using it ALONE would drop NEW_FLAG entirely; layering it
    // last shadows only what it actually holds.
    const merged = mergeServiceDeployEnv(
      layers({
        project: { OLD: "live", NEW_FLAG: "on" },
        frozen: { OLD: "release" },
        service: { SERVICE_ONLY: "live" },
      }),
      true,
    );
    expect(merged).toEqual({ OLD: "release", NEW_FLAG: "on", SERVICE_ONLY: "live" });
  });

  it("preserves the project → inline → service order within the live layers", () => {
    const merged = mergeServiceDeployEnv(
      layers({
        project: { A: "p", B: "p", C: "p" },
        inline: { B: "i", C: "i" },
        service: { C: "s" },
      }),
      true,
    );
    expect(merged).toEqual({ A: "p", B: "i", C: "s" });
  });
});

describe("frozen env and {{publicUrl}} tokens", () => {
  it("resolves a frozen token against TODAY's routing, not the release's host", () => {
    // The one thing frozen-wins could plausibly break. Token resolution runs
    // AFTER the merge and is never written back to `dep.envVars`, so a release
    // captured while the app answered on old.example.com still gets the current
    // hostname — otherwise every rollback would point the app at a dead origin.
    const merged = mergeServiceDeployEnv(
      layers({
        project: { API_ORIGIN: "https://stale-live-value.example" },
        frozen: { API_ORIGIN: "{{publicUrl:api}}" },
      }),
      true,
    );
    const { env, unresolved } = resolveEnvPublicUrls(merged, (service) =>
      service === "api" ? "https://api.today.example" : undefined,
    );
    expect(env.API_ORIGIN).toBe("https://api.today.example");
    expect(unresolved).toEqual([]);
  });

  it("leaves a frozen token UNSET when nothing routes there anymore", () => {
    // A blank origin reads as "configured, deliberately empty" to the container.
    // The service was deleted since the release, so the key is omitted and the
    // caller warns instead of shipping "".
    const merged = mergeServiceDeployEnv(
      layers({ frozen: { API_ORIGIN: "{{publicUrl:removed}}" } }),
      true,
    );
    const { env, unresolved } = resolveEnvPublicUrls(merged, () => undefined);
    expect("API_ORIGIN" in env).toBe(false);
    expect(unresolved).toEqual([{ key: "API_ORIGIN", tokens: ["{{publicUrl:removed}}"] }]);
  });
});

describe("diffFrozenEnv", () => {
  it("never emits a value from either side", () => {
    // The whole surface is serialized and compared against every secret in play:
    // env is output-masked everywhere else behind a write-gated reveal endpoint,
    // and a confirm dialog is not the place to widen that.
    const diff = diffFrozenEnv({
      frozen: { API_KEY: "sk-frozen-secret", GONE: "frozen-only-secret" },
      liveProject: { API_KEY: "sk-live-secret", ADDED: "added-secret" },
      strategy: "overlay",
    });
    const serialized = JSON.stringify(diff);
    for (const secret of [
      "sk-frozen-secret",
      "sk-live-secret",
      "frozen-only-secret",
      "added-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(diff.changes.map((c) => c.key).sort()).toEqual(["ADDED", "API_KEY", "GONE"]);
  });

  it("classifies each direction", () => {
    const diff = diffFrozenEnv({
      frozen: { CHANGED: "old", DELETED_SINCE: "old", SAME: "same" },
      liveProject: { CHANGED: "new", ADDED_SINCE: "new", SAME: "same" },
      strategy: "overlay",
    });
    expect(Object.fromEntries(diff.changes.map((c) => [c.key, c.direction]))).toEqual({
      CHANGED: "frozen-wins",
      DELETED_SINCE: "removed-since",
      ADDED_SINCE: "added-since",
    });
    // An identical value is not a change — listing it would bury the real ones.
    expect(diff.changes.some((c) => c.key === "SAME")).toBe(false);
    expect(diff.totalChanges).toBe(3);
    expect(diff.truncated).toBe(false);
  });

  it("marks a service-scoped key scopeAmbiguous and names the service", () => {
    // The one case the flat capture cannot resolve: the frozen map holds a single
    // value for a key that is per-service today, so replaying it lands the same
    // value on every service. Surfaced, not hidden.
    const diff = diffFrozenEnv({
      frozen: { DATABASE_URL: "postgres://frozen" },
      liveProject: {},
      liveServices: [
        { name: "api", overrides: { DATABASE_URL: "postgres://api-live" } },
        { name: "worker", overrides: {} },
      ],
      strategy: "overlay",
    });
    const change = diff.changes.find((c) => c.key === "DATABASE_URL");
    expect(change).toMatchObject({
      direction: "frozen-wins",
      scopeAmbiguous: true,
      serviceName: "api",
    });
  });

  it("flags a key as changing when only SOME services define it today", () => {
    // `worker` has no definition, so the frozen value would be introduced there
    // even though `api` already matches. Equal-on-one-service is not equal.
    const diff = diffFrozenEnv({
      frozen: { LOG_LEVEL: "debug" },
      liveProject: {},
      liveServices: [
        { name: "api", overrides: { LOG_LEVEL: "debug" } },
        { name: "worker", overrides: {} },
      ],
      strategy: "overlay",
    });
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]).toMatchObject({ key: "LOG_LEVEL", direction: "frozen-wins" });
  });

  it("omits a key every service already resolves to the frozen value", () => {
    const diff = diffFrozenEnv({
      frozen: { LOG_LEVEL: "debug" },
      liveProject: { LOG_LEVEL: "debug" },
      liveServices: [
        { name: "api", overrides: {} },
        { name: "worker", overrides: { LOG_LEVEL: "debug" } },
      ],
      strategy: "overlay",
    });
    expect(diff.changes).toEqual([]);
    expect(diff.totalChanges).toBe(0);
  });

  it("reports nothing for a unit swap, which never re-derives env", () => {
    // The container is restarted, not recreated. Listing changes here would
    // promise an effect the restore does not have.
    const diff = diffFrozenEnv({
      frozen: { API_KEY: "old" },
      liveProject: { API_KEY: "new" },
      strategy: "unchanged",
    });
    expect(diff).toEqual({
      strategy: "unchanged",
      changes: [],
      totalChanges: 0,
      truncated: false,
    });
  });

  it("carries the strategy through so the dialog can say kept vs dropped", () => {
    // Under `replace` (single-app) an added-since key is DROPPED by the restore;
    // under `overlay` it survives. Same direction, opposite consequence — the UI
    // needs the strategy to word it correctly.
    const input = {
      frozen: {},
      liveProject: { ADDED: "v" },
      strategy: "replace" as const,
    };
    expect(diffFrozenEnv(input).strategy).toBe("replace");
    expect(diffFrozenEnv({ ...input, strategy: "overlay" }).strategy).toBe("overlay");
  });

  it("ranks reverted values above additions before capping", () => {
    // Truncation must never be what hides a reverted secret, so the ranking is
    // applied first and `totalChanges` reports the true count.
    const frozen: Record<string, string> = { REVERTED: "old" };
    const liveProject: Record<string, string> = { REVERTED: "new" };
    for (let i = 0; i < ENV_DIFF_CAP; i++) liveProject[`ADDED_${i}`] = "v";

    const diff = diffFrozenEnv({ frozen, liveProject, strategy: "overlay", cap: 2 });
    expect(diff.changes[0]).toMatchObject({ key: "REVERTED", direction: "frozen-wins" });
    expect(diff.changes).toHaveLength(2);
    expect(diff.totalChanges).toBe(ENV_DIFF_CAP + 1);
    expect(diff.truncated).toBe(true);
  });
});
