import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * A rolled-back migration must leave the TARGET as if it was never there.
 *
 * The loop this closes: a move streamed its volumes to the target, failed later (deploy, verify),
 * and rolled back — restoring the source but leaving the volumes it had written. The conflict
 * guard then refused every retry with "Target server already has data in volume(s): … Remove or
 * rename them on the target", so the only way forward was `docker volume rm` on the box by hand.
 * Restoring the source while leaving debris on the target is not a rollback.
 *
 * Pinned in source: the alternative is two live Docker daemons and a deliberately failed
 * transfer, and the properties that matter here are all structural — WHEN the record is written,
 * WHO removes it, and that the source is never in scope.
 */
const src = readFileSync(new URL("./migration.orchestrator.ts", import.meta.url), "utf8");

/** The rollback method body, bounded so a match cannot drift in from a neighbour. */
const rollbackBody = (() => {
  const from = src.indexOf("  private async rollback(");
  return src.slice(from, src.indexOf("\n  private async ", from + 10));
})();

/** The shared undo, which both rollback and boot recovery must go through. */
const undoBody = (() => {
  const from = src.indexOf("  private async undoTargetSideEffects(");
  return src.slice(from, src.indexOf("\n  private async ", from + 10));
})();

/** Boot recovery's per-run block. */
const recoveryBody = (() => {
  const from = src.indexOf('if (run.status !== "queued" && run.sourceServerId) {');
  return src.slice(from, from + 1400);
})();

describe("rollback removes what the run wrote on the target", () => {
  it("goes through the shared undo", () => {
    expect(rollbackBody).toContain("this.undoTargetSideEffects(");
  });

  it("the undo removes on the TARGET server, never the source", () => {
    // The source holds production data and is explicitly never destroyed. Passing the wrong
    // server id here would delete the user's live volumes during a failure recovery — the worst
    // available outcome, and a one-character mistake.
    expect(undoBody).toContain("servers.targetServerId,");
    expect(undoBody).toContain("this.removeTargetVolumes(");
  });

  it("takes the list from the RUN's record, not from a local variable", () => {
    // A local would be empty on exactly the paths that need it — the undo is reached from the
    // live rollback AND from boot recovery, where no in-memory transfer result exists at all.
    expect(undoBody).toContain("run.targetVolumes ?? []");
  });

  it("clears the record afterwards, so manual cleanup doesn't re-offer gone volumes", () => {
    expect(undoBody).toContain("updateTargetVolumes(run.id, [])");
  });

  it("restores the server binding for a MOVE, and only for a move", () => {
    // A duplicate's project genuinely lives on the target; there is nothing to put back.
    expect(undoBody).toContain('run.mode === "project_move"');
    expect(undoBody).toContain("serverId: servers.sourceServerId");
  });

  it("never lets a cleanup failure mask the error that caused the rollback", () => {
    expect(undoBody).toContain("catch");
    expect(undoBody).toContain("remove them there before retrying");
  });
});

/**
 * Boot recovery is the path where this matters most and where it was missing.
 *
 * It tore the target down and restarted the source, then stopped — leaving `project.serverId`
 * naming the box it had just emptied, and the transferred volumes still on it. A crash is exactly
 * when nobody is watching, so an un-restored binding would sit there silently routing every read,
 * the Access URL and the next deploy to a server with nothing on it.
 */
describe("boot recovery undoes the same things a live rollback does", () => {
  it("calls the shared undo after restoring the source", () => {
    expect(recoveryBody).toContain("this.undoTargetSideEffects(");
    expect(recoveryBody.indexOf("teardownTargetAndRestoreSource")).toBeLessThan(
      recoveryBody.indexOf("undoTargetSideEffects"),
    );
  });

  it("leaves a PARKED run alone — the target is up and waiting on a human", () => {
    // awaiting_cutover / partial must survive a restart untouched; undoing them would tear down
    // a verified target the operator was about to confirm.
    expect(src).toContain('if (run.status === "awaiting_cutover" || run.status === "partial") {');
    expect(src).toContain("acknowledgeExecutionFinished(run.id)");
  });

  it("does not undo a crashed CUTOVER, which is a succeeded migration", () => {
    // Mid-cutover the source is already being destroyed on purpose; restoring anything there
    // would invert a successful move.
    expect(src).toContain('if (run.status === "cutover") {');
  });
});

describe("the record is written BEFORE the transfer, not after it", () => {
  it("the direct path records its intended writes up front", () => {
    // Collected-on-success meant an aborted transfer (cancel, link failure) recorded nothing,
    // so volumes already on the target became orphans with nothing pointing at them.
    const direct = src.slice(src.indexOf("const targetVolumes = [...volumeNames]"));
    expect(direct.slice(0, 600)).toContain("updateTargetVolumes(runId, targetVolumes)");
  });

  it("the relay path does the same", () => {
    const relay = src.slice(src.indexOf("const plannedTargetVolumes = rtB"));
    expect(relay.slice(0, 600)).toContain("updateTargetVolumes(runId, plannedTargetVolumes)");
  });

  it("excludes a `keep` volume, which is the target's OWN pre-existing data", () => {
    // The one case where a target volume is not ours to delete: the operator chose to keep what
    // was already there, so nothing was transferred and nothing may be removed.
    expect(src).toContain('.filter((ref) => resolution[ref] !== "keep")');
  });

  it("records the CLONE name when that resolution renames the target volume", () => {
    // Otherwise cleanup would chase the bare name and leave the scoped copy behind.
    expect(src).toContain('resolution[ref] === "clone" ? scopedVolumeName(projectSlug, ref) : ref');
  });

  it("no longer accumulates the list as transfers succeed", () => {
    expect(src).not.toContain("targetVolumes.push(");
  });
});

describe("the manual cleanup action and rollback share one implementation", () => {
  it("cleanupTargetData delegates to the same helper", () => {
    const manual = src.slice(src.indexOf("  async cleanupTargetData("));
    expect(manual.slice(0, 900)).toContain("this.removeTargetVolumes(");
  });

  it("the helper force-removes and tolerates a stubborn volume", () => {
    const helper = src.slice(src.indexOf("  private async removeTargetVolumes("));
    expect(helper.slice(0, 900)).toContain("docker volume rm -f");
    expect(helper.slice(0, 900)).toContain("|| true");
  });
});

/**
 * The self-healing half: OUR OWN debris on the target is not a conflict.
 *
 * Rollback cleaning up after itself only helps runs that recorded what they wrote. Anything
 * stranded by an earlier version, or by a crash between writing and recording, is invisible to
 * it — and the conflict guard then refuses forever, with `docker volume rm` on the box as the
 * only way out. `openship-<slug>-<vol>` is the name OUR deploy gives THIS project's volumes, so
 * finding one on a server the project doesn't live on identifies debris precisely.
 *
 * The dangerous mistake here is a loose prefix test, which is why that is pinned hardest: this
 * rule decides when it is acceptable to overwrite data on someone else's server.
 */
describe("an unused volume carrying this project's own namespace is reused, not refused", () => {
  it("builds the prefix from scopedVolumeName rather than re-spelling it", () => {
    // One place forms `openship-<slug>-…`; a hand-written "openship-" + slug here would drift
    // from it silently.
    expect(src).toContain('scopedVolumeName(ourSlug, "")');
  });

  it("requires the FULL project-slug prefix, not a bare openship- match", () => {
    // A loose test would match `openship-clincai-staging-pgdata` while moving `clincai` — a
    // different project's data, on a server we do not own, overwritten without asking.
    expect(src).toContain("name.startsWith(ourVolumePrefix!)");
    expect(src).toContain("name.length > ourVolumePrefix!.length");
    expect(src).not.toContain('name.startsWith("openship-")');
  });

  it("claims nothing when the project could not be read", () => {
    // Empty slug ⇒ prefix null ⇒ never matches. A project we can't identify is not one whose
    // volumes we may claim.
    expect(src).toContain('const ourVolumePrefix = ourSlug ? scopedVolumeName(ourSlug, "") : null');
  });

  it("keys off the SOURCE project's slug, which a duplicate's run project is not", () => {
    // The gap this closes: for a copy, `projectId` is the new project (`clincai-copy`) while the
    // volumes crossing are the source's (`openship-clincai-*`). Keyed off the run's project, the
    // rule silently stopped applying to the flow that needs it most — a failed duplicate stayed
    // stuck in the loop the rule exists to break.
    expect(src).toContain("const ourSlug = sourceProjectSlug || projectSlug");
    expect(src).toContain("const relayOurSlug = sourceProjectSlug || projectSlug");
    // And the run supplies it from the project the move is FROM.
    expect(src).toContain("input.projectMove.projectId).catch(() => null))?.slug");
  });

  it("still refuses when a container is running on that volume", () => {
    // The actual safety line: a name we recognise is ours to overwrite; a volume something is
    // running on is not, whoever named it.
    const rule = src.slice(src.indexOf("if (isOurNamespacedVolume(name)) {"));
    expect(rule.slice(0, 900)).toContain("docker ps --filter volume=");
    expect(rule.slice(0, 900)).toContain("if (running.length === 0)");
    expect(rule.slice(0, 900)).toContain("in use by");
  });

  it("overwrites by resolution rather than by deleting the volume first", () => {
    // `override` runs the transfer with clearTarget, so the reuse goes through the same path a
    // user-chosen override does — no second way to wipe a volume.
    const rule = src.slice(src.indexOf("if (isOurNamespacedVolume(name)) {"));
    expect(rule.slice(0, 900)).toContain('resolution[name] = "override"');
  });

  it("says in the log that it reused an earlier attempt's volume", () => {
    expect(src).toContain("left on the target by an earlier attempt at this move");
  });

  it("applies on the relay path too, so transfer mode can't decide whether you get stuck", () => {
    // Bounded by the loop's own END, not by a character count — a window sized in
    // characters silently stops covering the block the moment anything is added to it,
    // which is exactly what a contract test must not do.
    const from = src.indexOf("const relayOurPrefix");
    const to = src.indexOf("conflicts.push(", from);
    expect(from, "relay conflict block not found").toBeGreaterThan(-1);
    expect(to, "relay conflict block end not found").toBeGreaterThan(from);
    const relay = src.slice(from, to);
    expect(relay).toContain("name.startsWith(relayOurPrefix)");
    expect(relay).toContain("name.length > relayOurPrefix.length");
  });
});
