import { describe, expect, it, test } from "vitest";
import { getTableColumns } from "drizzle-orm";
import * as schema from "./schema";
import { filterRowToKnownColumns, assertDumpSelfContained } from "./dump";

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
});
