import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { beginFetchState, type FetchState } from "./begin-fetch-state";

/**
 * The one decision behind an infinite render loop.
 *
 * `invalidateProjectCaches(id)` re-runs the fetch effect for every mounted consumer, to refresh
 * them in place. The project page renders a full-page skeleton whenever its info read reports
 * loading — so a refresh that reported loading unmounted the page's entire subtree and remounted
 * it when the response landed. For the migration panel, whose mount publishes its run's phase
 * (which invalidates), that closed a cycle: invalidate → skeleton → unmount → remount →
 * invalidate, forever, hammering /info and /migrations/:id and reopening the SSE stream each time.
 */
const loaded: FetchState<{ n: number }> = { data: { n: 1 }, isLoading: false, error: null };
const empty: FetchState<{ n: number }> = { data: null, isLoading: true, error: null };

describe("a REFRESH of what's already on screen", () => {
  it("does not report loading", () => {
    // The whole fix. Anything that gates a skeleton on `isLoading` would otherwise tear its
    // subtree down and build it again on every invalidation.
    expect(beginFetchState(loaded, "p1", "p1").isLoading).toBe(false);
  });

  it("keeps the current data visible while the new copy is in flight", () => {
    expect(beginFetchState(loaded, "p1", "p1").data).toEqual({ n: 1 });
  });

  it("clears a previous error, since a fetch is now in flight", () => {
    const failedThenRetried = { data: { n: 1 }, isLoading: false, error: "boom" };
    expect(beginFetchState(failedThenRetried, "p1", "p1").error).toBeNull();
  });
});

describe("a FIRST load", () => {
  it("reports loading, because there is genuinely nothing to show", () => {
    expect(beginFetchState(empty, null, "p1").isLoading).toBe(true);
  });

  it("reports loading after a failure dropped the data", () => {
    const afterError = { data: null, isLoading: false, error: "boom" };
    const next = beginFetchState(afterError, null, "p1");
    expect(next.isLoading).toBe(true);
    expect(next.error).toBeNull();
  });
});

describe("a NAVIGATION to a different id", () => {
  it("reports loading even though data is in hand — it is the WRONG project's data", () => {
    // The trap in the fix: "we have data, so don't show a spinner" is right for a refresh and
    // wrong here. Calling this loaded renders project A's page under project B's URL.
    expect(beginFetchState(loaded, "p1", "p2").isLoading).toBe(true);
  });
});

/**
 * The other half of the loop: the guard on the side effect that fires the refresh.
 */
describe("the run-phase publisher cannot re-fire on remount", () => {
  const wizard = readFileSync(
    new URL("../components/migration/ServerMigrationWizard.tsx", import.meta.url),
    "utf8",
  );

  /** The publisher effect only — bounded by its own dep array, not a guessed character budget. */
  const from = wizard.indexOf("Publish the run's phase");
  const effect = wizard.slice(from, wizard.indexOf("}, [run]);", from));

  it("dedupes in module scope, not in per-mount state", () => {
    // A `useRef` guard resets on every remount — and the guarded effect can remount its own
    // component, so the ref could never hold. The dedupe has to outlive the mount.
    expect(wizard).toContain("const publishedPhases = new Set<string>()");
    expect(effect).toContain("publishedPhases.has(key)");
    expect(effect).not.toContain("publishedPhase.current");
  });

  it("keys the guard by project AND run AND status, so a later run still publishes", () => {
    expect(effect).toContain("`${id}:${run.id}:${status}`");
  });
});
