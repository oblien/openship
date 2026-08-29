import { describe, expect, it, test } from "vitest";
import { getTableColumns } from "drizzle-orm";
import * as schema from "./schema";
import {
  filterRowToKnownColumns,
  assertDumpSelfContained,
  stripInstanceRefsInPlace,
} from "./dump";

// Cross-version ingest tolerance for restoreSubgraph (cloud transfer / project
// transfer). Drizzle builds the INSERT column list from the dumped row's keys =
// the SENDER's schema. When a freshly-updated instance dumps into a receiver on
// an OLDER schema, a sender-only column would make Postgres reject the whole
// insert. restoreSubgraph filters every row to the receiver's known columns
// first; this locks that filter against the REAL project schema.

const projectCols = new Set(Object.keys(getTableColumns(schema.project)));

describe("filterRowToKnownColumns (version-skew ingest tolerance)", () => {
  test("drops sender-only columns the receiver schema does not model", () => {
    const { row, dropped } = filterRowToKnownColumns(
      {
        id: "proj_1",
        name: "app",
        // columns a NEWER sender might carry that this build lacks:
        someFutureColumn: "v0.9.0",
        anotherNewField: 42,
      },
      projectCols,
    );
    expect(dropped.sort()).toEqual(["anotherNewField", "someFutureColumn"]);
    expect(row).not.toHaveProperty("someFutureColumn");
    expect(row).not.toHaveProperty("anotherNewField");
    // Real columns survive untouched.
    expect(row.id).toBe("proj_1");
    expect(row.name).toBe("app");
  });

  test("keeps every real project column and drops nothing when the row matches", () => {
    const full: Record<string, unknown> = {};
    for (const k of projectCols) full[k] = null;
    const { row, dropped } = filterRowToKnownColumns(full, projectCols);
    expect(dropped).toEqual([]);
    expect(new Set(Object.keys(row))).toEqual(projectCols);
  });

  test("preserves falsy/null values for known columns (does not treat them as absent)", () => {
    const { row, dropped } = filterRowToKnownColumns(
      { id: "proj_2", autoDeploy: false, activeDeploymentId: null, unknownX: "drop" },
      projectCols,
    );
    expect(dropped).toEqual(["unknownX"]);
    expect(row).toHaveProperty("autoDeploy", false);
    expect(row).toHaveProperty("activeDeploymentId", null);
  });
});

// Cross-tenant ingest guard (SaaS audit, critical): on the remap path (cloud
// ingest / project transfer) a child row's parent FK is NOT org-remapped, so a
// crafted dump could attach e.g. a service to a VICTIM's project → cross-tenant
// write / RCE. The dump must be self-contained: every projectId/deploymentId/
// serviceId/groupId must reference a parent PRESENT IN THE DUMP.
describe("assertDumpSelfContained (cross-tenant ingest guard)", () => {
  const dump = (tables: Record<string, unknown[]>) =>
    ({ formatVersion: 1, scope: { kind: "organization", organizationId: "o" }, tables }) as never;

  it("rejects a child whose projectId is not in the dump (the exploit)", () => {
    expect(() =>
      assertDumpSelfContained(
        dump({ service: [{ id: "svc_evil", projectId: "prj_VICTIM", image: "attacker/evil" }] }),
      ),
    ).toThrow(/references a project not present/);
  });

  it("rejects a project whose groupId points at a foreign project_app", () => {
    expect(() =>
      assertDumpSelfContained(dump({ project: [{ id: "prj_1", groupId: "app_VICTIM" }] })),
    ).toThrow(/references a project_app not present/);
  });

  it("rejects a service_deployment referencing a foreign deploymentId/serviceId", () => {
    expect(() =>
      assertDumpSelfContained(
        dump({ service_deployment: [{ id: "sd_1", deploymentId: "dep_VICTIM", serviceId: "svc_1" }] }),
      ),
    ).toThrow(/not present in the dump/);
  });

  it("accepts a self-contained dump (all parents present)", () => {
    expect(() =>
      assertDumpSelfContained(
        dump({
          project_app: [{ id: "app_1" }],
          project: [{ id: "prj_1", groupId: "app_1", organizationId: "o" }],
          service: [{ id: "svc_1", projectId: "prj_1" }],
          deployment: [{ id: "dep_1", projectId: "prj_1" }],
          service_deployment: [{ id: "sd_1", deploymentId: "dep_1", serviceId: "svc_1" }],
        }),
      ),
    ).not.toThrow();
  });

  it("ignores null FKs", () => {
    expect(() =>
      assertDumpSelfContained(dump({ project: [{ id: "prj_1", groupId: null, organizationId: "o" }] })),
    ).not.toThrow();
  });

  it("rejects a backup_run whose destinationId points at a foreign backup_destination (credential-adoption exploit)", () => {
    expect(() =>
      assertDumpSelfContained(
        dump({
          backup_run: [
            { id: "bkr_evil", destinationId: "bkd_VICTIM", projectId: "prj_1", organizationId: "o" },
          ],
          project: [{ id: "prj_1", organizationId: "o" }],
        }),
      ),
    ).toThrow(/references a backup_destination not present/);
  });

  it("rejects a backup_restore whose runId points at a foreign backup_run", () => {
    expect(() =>
      assertDumpSelfContained(
        dump({ backup_restore: [{ id: "bks_1", runId: "bkr_VICTIM", organizationId: "o" }] }),
      ),
    ).toThrow(/references a backup_run not present/);
  });

  it("rejects a notification_subscription whose channelId points at a foreign notification_channel (cross-tenant channel attach)", () => {
    expect(() =>
      assertDumpSelfContained(
        dump({
          notification_subscription: [
            { id: "nsb_evil", channelId: "nch_VICTIM", organizationId: "o", userId: "u" },
          ],
        }),
      ),
    ).toThrow(/references a notification_channel not present/);
  });

  it("accepts a self-contained backup subgraph (destination + run present)", () => {
    expect(() =>
      assertDumpSelfContained(
        dump({
          backup_destination: [{ id: "bkd_1", organizationId: "o" }],
          project: [{ id: "prj_1", organizationId: "o" }],
          backup_run: [
            { id: "bkr_1", destinationId: "bkd_1", projectId: "prj_1", organizationId: "o" },
          ],
          backup_restore: [
            { id: "bks_1", runId: "bkr_1", destinationId: "bkd_1", organizationId: "o" },
          ],
        }),
      ),
    ).not.toThrow();
  });
});

// `servers` and `mail_servers` are declared INSTANCE-scope only, so they never travel
// in an organization or project dump — but five of their children do, carrying a
// dangling reference. Two independent consequences, one fix each:
//
//   FUNCTIONAL — on the SaaS those tables are permanently empty and the FKs are not
//   DEFERRABLE, so shipping a non-null serverId takes a raw FK violation at insert:
//   promote-to-cloud / migrate-to-cloud fails outright. Hence the dump-side scrub.
//
//   SECURITY — assertDumpSelfContained's FK_PARENT map originally omitted these two
//   columns, so a crafted dump could point backup_destination.serverId at a server row
//   that ALREADY EXISTS on the receiver and have the restore adopt its SSH credentials
//   — the same attach-to-a-pre-existing-parent shape the destinationId entry guards
//   against. Safe to reject only BECAUSE the scrub means a legitimate cross-instance
//   dump never carries one.
describe("instance-scope FK references (servers / mail_servers)", () => {
  const dump = (tables: Record<string, unknown[]>) =>
    ({ formatVersion: 1, scope: { kind: "organization", organizationId: "o" }, tables }) as never;

  it("nulls every instance-scope reference in place", () => {
    const tables: Record<string, Array<Record<string, unknown>>> = {
      project: [{ id: "prj_1", serverId: "srv_1", name: "keep me" }],
      backup_destination: [{ id: "bkd_1", serverId: "srv_1" }],
      backup_policy: [{ id: "bkp_1", mailServerId: "srv_1" }],
      backup_run: [{ id: "bkr_1", mailServerId: "srv_1" }],
      backup_restore: [{ id: "bks_1", forkMailServerId: "srv_1" }],
    };
    stripInstanceRefsInPlace(tables);

    expect(tables.project![0]!.serverId).toBeNull();
    expect(tables.backup_destination![0]!.serverId).toBeNull();
    expect(tables.backup_policy![0]!.mailServerId).toBeNull();
    expect(tables.backup_run![0]!.mailServerId).toBeNull();
    expect(tables.backup_restore![0]!.forkMailServerId).toBeNull();
    // Everything else is untouched — this is a targeted scrub, not a filter.
    expect(tables.project![0]!.name).toBe("keep me");
    expect(tables.project![0]!.id).toBe("prj_1");
  });

  it("is a no-op on tables and rows that carry no instance reference", () => {
    const tables: Record<string, Array<Record<string, unknown>>> = {
      project: [{ id: "prj_1", serverId: null }],
      service: [{ id: "svc_1", projectId: "prj_1" }],
    };
    stripInstanceRefsInPlace(tables);
    expect(tables.project![0]!.serverId).toBeNull();
    expect(tables.service![0]).toEqual({ id: "svc_1", projectId: "prj_1" });
  });

  it("rejects a crafted serverId that would attach to a pre-existing server row", () => {
    expect(() =>
      assertDumpSelfContained(
        dump({ backup_destination: [{ id: "bkd_evil", serverId: "srv_VICTIM" }] }),
      ),
    ).toThrow(/references a servers not present/);
  });

  it("rejects crafted mail-server references on all three carrying tables", () => {
    for (const [table, row] of [
      ["backup_policy", { id: "bkp_evil", mailServerId: "srv_VICTIM" }],
      ["backup_run", { id: "bkr_evil", mailServerId: "srv_VICTIM" }],
      ["backup_restore", { id: "bks_evil", forkMailServerId: "srv_VICTIM" }],
    ] as const) {
      expect(() => assertDumpSelfContained(dump({ [table]: [row] })), table).toThrow(
        /references a mail_servers not present/,
      );
    }
  });

  it("accepts a scrubbed dump — the two halves agree", () => {
    // The property that makes rejecting safe: run the scrub, and the assert passes.
    const tables: Record<string, Array<Record<string, unknown>>> = {
      project: [{ id: "prj_1", serverId: "srv_1", groupId: null, organizationId: "o" }],
      backup_destination: [{ id: "bkd_1", serverId: "srv_1" }],
    };
    stripInstanceRefsInPlace(tables);
    expect(() => assertDumpSelfContained(dump(tables))).not.toThrow();
  });
});
