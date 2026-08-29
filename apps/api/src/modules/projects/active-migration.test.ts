import { describe, expect, it } from "vitest";
import type { DockerMigrationRun } from "@repo/db";
import { readActiveMigration } from "./active-migration";

/**
 * The run→project-payload projection. Small on purpose, and tested because the thing it gets
 * right is a NEGATIVE: what it leaves behind.
 */
const run = {
  id: "dmr_1",
  status: "moving_data",
  mode: "project_move",
  organizationId: "org1",
  projectId: "p1",
  projectName: "clincai",
  sourceServerId: "srvA",
  targetServerId: "srvB",
  // The two fields that must never reach a project reader.
  confirmationToken: "deadbeefcafe",
  inputSnapshot: {
    projectMove: { projectId: "p1", intent: "move" },
    env: { DATABASE_URL: "postgres://user:pw@host/db" },
  },
  scannedContainerIds: { web: "abc123" },
  logs: "…",
} as unknown as DockerMigrationRun;

describe("readActiveMigration", () => {
  it("answers null for no run — the common case", () => {
    expect(readActiveMigration(null)).toBeNull();
    expect(readActiveMigration(undefined)).toBeNull();
  });

  it("carries only display fields plus the server-derived action flag", () => {
    expect(readActiveMigration(run)).toEqual({
      id: "dmr_1",
      status: "moving_data",
      mode: "project_move",
      needsAction: false,
    });
  });

  it("NEVER carries the confirmation token", () => {
    // The token authorises the destructive cutover — stopping and destroying the source
    // server's containers. The project payload is `project:read`; every migration route is
    // `server:write`. Spreading the run row here (the obvious, wrong implementation) would
    // hand a project-only reader the one secret that finishes a cross-server teardown.
    const out = JSON.stringify(readActiveMigration(run));
    expect(out).not.toContain("deadbeefcafe");
    expect(out).not.toContain("confirmationToken");
  });

  it("NEVER carries the start snapshot, which holds the deploy env", () => {
    const out = JSON.stringify(readActiveMigration(run));
    expect(out).not.toContain("inputSnapshot");
    expect(out).not.toContain("postgres://");
  });

  it("is an allowlist, so a field added to the run row later cannot leak by default", () => {
    const withNewSecret = { ...run, someFutureToken: "s3cr3t" } as unknown as DockerMigrationRun;
    expect(Object.keys(readActiveMigration(withNewSecret) ?? {}).sort()).toEqual([
      "id",
      "mode",
      "needsAction",
      "status",
    ]);
  });

  it("surfaces a failed cutover as actionable without exposing its error", () => {
    const failedCutover = {
      ...run,
      status: "cutover",
      errorMessage: "ssh://secret-host failed",
    } as unknown as DockerMigrationRun;

    expect(readActiveMigration(failedCutover)).toEqual({
      id: "dmr_1",
      status: "cutover",
      mode: "project_move",
      needsAction: true,
    });
    expect(JSON.stringify(readActiveMigration(failedCutover))).not.toContain("secret-host");
  });

  it("passes a duplicate's mode through, so a client can tell the two apart", () => {
    const copy = { ...run, mode: "project_copy" } as unknown as DockerMigrationRun;
    expect(readActiveMigration(copy)?.mode).toBe("project_copy");
  });
});
