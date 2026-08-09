import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * WHERE the release phase sits in the deploy pipeline is the safety property,
 * and it is not observable from `release-phase.ts` alone: that module runs
 * commands and throws, but only its call site decides whether a failure costs
 * the user their running app.
 *
 * The phase must run after the build has produced an artifact and BEFORE
 * anything cuts over — before any domain row is created, before
 * `runDeployPipeline` (whose `activate` step is where every runtime on this path
 * starts the new workload). Then a failed migration aborts with the previous
 * version still running and still routed, and with nothing to roll back.
 *
 * `executeServerDeploy` is a private function inside a 2,000-line module with a
 * platform, a runtime and a live DB behind it, so this pins the wiring at the
 * source level — the same approach `test/lib/proxy-settings-wiring.test.ts`
 * takes for route payloads. The behaviour of the phase itself (ordering,
 * fail-fast, skips) is covered in `release-phase.test.ts`.
 */
const PIPELINE = readFileSync(
  new URL("../../../src/modules/deployments/build-pipeline.ts", import.meta.url),
  "utf8",
);

/** Index of `needle` inside `executeServerDeploy`, or -1. */
function atInServerDeploy(needle: string): number {
  const start = PIPELINE.indexOf("async function executeServerDeploy(");
  expect(start, "executeServerDeploy was renamed — re-anchor this test").toBeGreaterThan(-1);
  const found = PIPELINE.indexOf(needle, start);
  return found === -1 ? -1 : found - start;
}

describe("release phase — pipeline wiring", () => {
  it("runs after the deploy config is assembled and before runDeployPipeline", () => {
    const config = atInServerDeploy("const deployConfig: DeployConfig = {");
    const release = atInServerDeploy("await runReleasePhase({");
    const pipeline = atInServerDeploy("await runDeployPipeline(");
    expect(config).toBeGreaterThan(-1);
    expect(release).toBeGreaterThan(config);
    expect(pipeline).toBeGreaterThan(release);
  });

  // A deploy that fails in the release phase must not leave orphan domain rows
  // behind — which is only true while the phase runs before they are created.
  it("runs before any domain record is created", () => {
    const release = atInServerDeploy("await runReleasePhase({");
    const domains = atInServerDeploy("await ensureRouteDomainRecord({");
    expect(release).toBeGreaterThan(-1);
    expect(domains).toBeGreaterThan(release);
  });

  // The failure path: report the deploy failed and RETURN. Falling through would
  // activate the new version anyway, which is the exact outcome the phase exists
  // to prevent.
  it("fails the deployment and returns instead of continuing to activate", () => {
    const release = atInServerDeploy("await runReleasePhase({");
    const tail = PIPELINE.slice(
      PIPELINE.indexOf("async function executeServerDeploy(") + release,
    );
    const catchBlock = tail.slice(tail.indexOf("} catch (err) {"), tail.indexOf("// Resolve the previous deployment"));
    expect(catchBlock).toContain("await onFailure(ctx,");
    expect(catchBlock).toContain("return;");
  });

  // Snapshotted, not read live: a redeploy that REBUILDS an old deployment runs
  // the commands that release declared rather than today's.
  it("takes its commands from the deployment snapshot, not the project row", () => {
    expect(PIPELINE).toContain("releaseCommands: snapshot.releaseCommands");
  });

  /**
   * ...but the way BACK does not replay them. `pinnedAppImage` is the exact
   * discriminator: only a rollback restore pins a prebuilt image, because a plain
   * Redeploy runs `withoutPinnedArtifacts` and rebuilds natively. Pinning the
   * derivation here matters because swapping it for something looser (any
   * `handoverImages` entry, say) would also catch the migration cutover handover,
   * which is not a rollback.
   */
  it("derives the rollback skip from the pinned app image, not a looser signal", () => {
    const gate = atInServerDeploy("const rollbackImage = pinnedAppImage(snapshot);");
    const release = atInServerDeploy("await runReleasePhase({");
    expect(gate, "rollback gate missing or renamed").toBeGreaterThan(-1);
    expect(release).toBeGreaterThan(gate);
  });

  // The skip has to travel as `deliberateSkipReason`, not `unsupportedReason`:
  // the latter tells the operator to run the commands by hand, which is the
  // opposite of what a rollback wants.
  it("passes the rollback as a deliberate skip, not as an unsupported runtime", () => {
    const start = PIPELINE.indexOf("async function executeServerDeploy(");
    const call = PIPELINE.indexOf("await runReleasePhase({", start);
    const block = PIPELINE.slice(call, PIPELINE.indexOf("});", call));
    expect(block).toContain("deliberateSkipReason: rollbackImage");
  });
});
