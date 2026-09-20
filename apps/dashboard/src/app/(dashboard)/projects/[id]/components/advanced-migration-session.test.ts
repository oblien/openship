import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Where the Advanced tab learns that a migration is running.
 *
 * The answer has to be the PROJECT PAYLOAD, and that is a property of the wiring rather than
 * of any rendered output — invisible to a typecheck and to a static render, so it is pinned
 * here in source.
 *
 * The version this replaced asked the migration API on mount. Everything about that was
 * subtly wrong and all of it looked fine in isolation: the tab only knew about a run while it
 * was mounted, so a reload restarted the clock; no OTHER surface knew at all, so the project
 * cards and the page header read "Live" through an entire cross-server move; and the answer
 * had two sources that could disagree. Reading it off the payload every surface already loads
 * makes the pill, the header and this panel one fact.
 */
const advanced = readFileSync(new URL("./AdvancedSettings.tsx", import.meta.url), "utf8");
const wizard = readFileSync(
  new URL("../../../../../components/migration/ServerMigrationWizard.tsx", import.meta.url),
  "utf8",
);
const client = readFileSync(
  new URL("../../../../../lib/api/server-migration.ts", import.meta.url),
  "utf8",
);

describe("the Advanced tab reads the live run off the project, not the migration API", () => {
  it("takes the run from the payload", () => {
    expect(advanced).toContain("projectData?.activeMigration");
  });

  it("does not talk to the migration API at all", () => {
    // The whole point. A fetch here — for the run, its status, anything — reintroduces the
    // second source of truth, and it will disagree the moment the payload is refreshed by
    // something else.
    expect(advanced).not.toContain("dockerMigrationApi");
    expect(advanced).not.toContain("getActiveForProject");
  });

  it("has no per-project ACTIVE-run fetch left on the client either", () => {
    // Deleted rather than left unused: an unused endpoint is an invitation to re-add the
    // panel-local fetch this replaced.
    expect(client).not.toContain("getActiveForProject");
    // Narrowed to the /active route on purpose. A blanket "no `?projectId=`" was wrong the
    // moment a project gained a runs LIST — that query is fine and expected; what must not
    // come back is asking the migration module which run is live for a project, because the
    // project payload answers that.
    expect(client).not.toMatch(/active\}?\?projectId=/);
  });
});

describe("the session survives a reload, and closing it is still possible", () => {
  it("opens the run panel from the payload's run id", () => {
    expect(advanced).toContain("const openRunId = startedRunId ?? activeRun?.id ?? null");
    expect(advanced).toContain("initialRunId={sessionRunId}");
  });

  it("keeps a just-started run open ahead of the payload, and past the run's end", () => {
    // `startedRunId` first in that coalesce: confirming a move should land on its session
    // immediately, not after a refetch — and should stay there once the run goes terminal so
    // the operator sees the result instead of being dropped back into settings.
    expect(advanced).toContain("setStartedRunId(runId)");
  });

  it("lets Back win over the payload, by run id so the NEXT run still opens", () => {
    expect(advanced).toContain("openRunId !== dismissedRunId");
    expect(advanced).toContain("setDismissedRunId(openRunId)");
  });
});

describe("every other surface converges on the same fact", () => {
  it("starting a run invalidates the project, so the pills elsewhere update", () => {
    const started = advanced.slice(advanced.indexOf("onStarted={"));
    expect(started).toContain("invalidateProjectCaches(projectId)");
  });

  it("leaving the session re-reads the project, in case the run finished inside it", () => {
    const leave = advanced.slice(advanced.indexOf("const leaveSession"));
    expect(leave.slice(0, 500)).toContain("invalidateProjectCaches(projectId)");
  });

  // The publisher effect, bounded by its own dep array. Anchored on the doc comment rather
  // than on `publishedPhase`, which also names the module-level Set far above it.
  const publisher = (() => {
    const from = wizard.indexOf("Publish the run's phase");
    return wizard.slice(from, wizard.indexOf("}, [run]);", from));
  })();

  it("the run panel republishes the project on every phase change", () => {
    // The payload is revision-invalidated, not polled, so without this a project would read
    // "Migrating" after its run succeeded and would only start reading it on a full reload.
    // The panel is the one place in the client watching a run's status, and it does so for
    // every entry point — project tab, server tab, library modal.
    expect(publisher).toContain("invalidateProjectCaches(id)");
  });

  it("republishes BOTH projects a run can be about", () => {
    // A duplicate's `projectId` is repointed at the project it creates, so the source project
    // — where the operator started it — is only reachable through the start snapshot.
    expect(publisher).toContain("projectMove");
  });
});

describe("the tab agrees with the pill about what the run is doing", () => {
  it("asks the shared predicate rather than re-listing the parked phases", () => {
    expect(advanced).toContain("migrationNeedsOperator(activeRun)");
  });

  it("never calls a parked run 'in progress'", () => {
    // The row used to phrase every live run the same way, which produced the self-contradictory
    // "In progress — Awaiting cutover" for a run that had stopped and was waiting for a human.
    const row = advanced.slice(advanced.indexOf("{/* Migration"), advanced.indexOf("{/* Routing"));
    expect(row).toContain("t.projects.migrationAwaitingHint");
    // And the amber tone is reserved for that state — an advancing transfer asks for nothing,
    // while amber means "act now" everywhere else in the app.
    expect(row).toContain('iconTone={runNeedsOperator ? "amber" : "primary"}');
  });
});

/**
 * A project run must never fall back to the SERVER scan flow.
 *
 * This is the bug from the screenshot: on a project's Advanced tab, a failed migration offered
 * "Edit & retry", which called `handleScan()` — so the operator landed on "Existing services /
 * Flat listing / Scanning existing reverse proxy…", door A's UI, being invited to adopt
 * containers from a box they never asked about. The panel is shared on purpose (one progress,
 * log, cutover and rollback implementation), so what has to differ is the ENTRY, not a fork of
 * the whole component.
 */
describe("migration is generic; the server is one entry point", () => {
  it("the project tab declares its origin", () => {
    expect(advanced).toContain('origin="project"');
  });

  it("a project origin renders no scan/select subtree at all", () => {
    // Gate, not a style: every state that leaves `inProgress` false — a finished run, a run id
    // that no longer resolves, a retry between runs — used to fall through to the scan screen.
    const gate = wizard.slice(wizard.indexOf('if (origin === "project")'));
    expect(gate.slice(0, 600)).toContain("onBack");
    expect(wizard.indexOf('if (origin === "project")')).toBeLessThan(
      wizard.indexOf("// Steps 2 (Source) & 3 (Configure)"),
    );
  });

  it("a failed PROJECT run retries in place instead of re-scanning", () => {
    expect(wizard).toContain("const retryProjectRun = async ()");
    const retry = wizard.slice(wizard.indexOf("const retryProjectRun"));
    expect(retry.slice(0, 1200)).toContain("startProjectMove({");
    expect(retry.slice(0, 1200)).not.toContain("handleScan");
  });

  it("offers Change target as the way to a DIFFERENT destination", () => {
    // "Edit & retry" bundled both; for a project the only thing worth editing is the target,
    // and that lives on the card that started the run.
    expect(wizard).toContain("m.tab.changeTarget");
    expect(wizard).toContain("m.tab.retryRun");
  });

  it("keeps the scan retry for SCAN-started runs, which do have a selection to revisit", () => {
    expect(wizard).toContain("{failed && !projectRun && run?.inputSnapshot && (");
  });

  it("decides which it is from the run's mode, not from a prop the caller could get wrong", () => {
    expect(wizard).toContain('run?.mode === "project_move" || run?.mode === "project_copy"');
  });
});

/**
 * History is listed on both sides, from one list component and one endpoint.
 */
describe("migration history", () => {
  const list = readFileSync(
    new URL("../../../../../components/migration/MigrationRunList.tsx", import.meta.url),
    "utf8",
  );
  const serverTab = readFileSync(
    new URL("../../../../../components/migration/MigrationsTab.tsx", import.meta.url),
    "utf8",
  );

  it("the project tab lists its own runs", () => {
    expect(advanced).toContain("<ProjectMigrationHistory");
  });

  it("both sides render the SAME row component", () => {
    expect(serverTab).toContain("<MigrationRunList");
    // The server tab kept no private copy of the rows after the extraction.
    expect(serverTab).not.toContain("ChevronRight");
  });

  it("the row's only viewpoint-dependent part is the from→to line", () => {
    expect(list).toContain('viewpoint.kind === "project"');
    expect(list).toContain("run.targetServerId === viewpoint.serverId");
  });
});
