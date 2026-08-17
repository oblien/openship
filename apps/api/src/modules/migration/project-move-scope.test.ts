import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The scan a project move performs is PRE-SET to the project's own containers.
 *
 * What this pins is an ordering and a scope, both of which read as harmless if reversed and cost
 * the operator real time when they are. The version this replaced ran a full
 * `discoverServerStack` and filtered by label afterwards: on a 20-container box that is
 * "Inspecting 20 container(s)…" to keep 5, plus compose-file reads and per-image env lookups
 * across every unrelated stack on the host — and for a duplicate it happened twice, because
 * `adoptServerStack` scanned again.
 *
 * Source-level because the alternative is a Docker daemon. The scan's own narrowing logic is
 * exercised by `docker-inspect` behaviour; what matters here is that this caller uses it, and
 * that the label set — not the scan option — remains the ownership check.
 */
const move = readFileSync(new URL("./project-move.ts", import.meta.url), "utf8");
const inspect = readFileSync(new URL("./docker-inspect.service.ts", import.meta.url), "utf8");
const orchestrator = readFileSync(
  new URL("./migration.orchestrator.ts", import.meta.url),
  "utf8",
);

describe("the workload is resolved from the label set, then scanned", () => {
  it("asks which containers are ours BEFORE scanning", () => {
    expect(move.indexOf("listProjectContainerIds")).toBeLessThan(
      move.indexOf("discoverServerStack("),
    );
  });

  it("hands that list to the scan as its scope", () => {
    expect(move).toContain("onlyContainerIds: ourContainerIds");
  });

  it("does not scan at all when nothing of ours is running", () => {
    // The refusal is already decided one call earlier, so a full scan on the way to it is the
    // worst trade available: longest wait, guaranteed failure.
    const guard = move.slice(move.indexOf("if (ourContainerIds.length === 0)"));
    expect(guard.slice(0, 400)).toContain("return planProjectMove(");
  });

  it("still filters by the label set after the scan — the scope is not the ownership check", () => {
    // If `onlyContainerIds` ever widened (a bug, or a caller passing undefined), nothing
    // foreign may reach the workload. `planProjectMove` is what guarantees that.
    expect(move).toContain("ourContainerIds,");
    expect(move).toContain("planProjectMove({");
  });
});

describe("the scan honours the scope where it is cheap to honour", () => {
  it("narrows the container list before the ownership split and the inspect fan-out", () => {
    const listing = inspect.indexOf("const containers = scoped");
    expect(listing).toBeGreaterThan(-1);
    // Before the split (`isOpenshipOwned`) and therefore before `inspectContainer`.
    expect(listing).toBeLessThan(inspect.indexOf("const isOpenshipOwned"));
  });

  it("treats an EMPTY selection as no candidates, not as 'everything'", () => {
    // `length > 0 ? Set : null` is the tempting version and turns "these zero containers" into
    // a full-host scan.
    expect(inspect).toContain("Array.isArray(only) ? new Set(only.filter(Boolean)) : null");
  });

  it("says what it narrowed to, so a small number doesn't read as a broken scan", () => {
    expect(inspect).toContain("of ${allContainers.length} container(s) (this project's)");
  });

  it("skips the whole-box manifest prune when scoped", () => {
    expect(inspect).toContain("if (!scoped) {");
  });
});

describe("a duplicate no longer scans the server a second time", () => {
  it("clones the project's records instead of re-adopting its containers", () => {
    const copyBranch = orchestrator.slice(
      orchestrator.indexOf("if (copying) {"),
      orchestrator.indexOf("return {", orchestrator.indexOf("if (copying) {")),
    );
    expect(copyBranch).toContain("cloneProjectToServer({");
    // `adoptServerStack` calls `discoverServerStack` internally — that second scan is the thing
    // being removed here, not just a style preference.
    expect(copyBranch).not.toContain("adoptServerStack(");
  });

  it("leaves the SCAN door using adoptServerStack, untouched", () => {
    // Door A must keep working exactly as before; this change is additive to it.
    expect(orchestrator).toContain("const adopt = await adoptServerStack({");
  });
});
