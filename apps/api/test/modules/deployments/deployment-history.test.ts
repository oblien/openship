import { beforeAll, describe, expect, it } from "vitest";
import { repos } from "@repo/db";
import { parseInput, ListDeploymentsSchema, ProjectControlSchemas, UpdateProjectBody } from "@repo/contracts";
import { listDeployments } from "@repo/platform/engine/modules/deployments/deployment.service";
import { createProjectInspectionOperations } from "@repo/platform/engine/modules/projects/project-inspection.operations";
import { ENV_MASK } from "@repo/platform/engine/lib/secret-env";
import { seedOrg, seedProject, seedDeployment, setActive } from "../../helpers/seed";

describe("deployment history through the shared engine and real database", () => {
  let org: Awaited<ReturnType<typeof seedOrg>>;
  let project: Awaited<ReturnType<typeof seedProject>>;
  let ids: string[];
  const inspection = createProjectInspectionOperations(() => {});

  beforeAll(async () => {
    org = await seedOrg();
    project = await seedProject(org.organizationId, { name: "History example" });
    ids = [];
    for (let index = 0; index < 45; index += 1) {
      const dep = await seedDeployment(project, {
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)),
        status: index < 3 ? ["failed", "action_required", "partial_failure"][index] : "ready",
        commitMessage: index === 0 ? "Fix 100%_literal" : `Release ${index}`,
        commitSha: `${String(index).padStart(8, "0")}abcdef`,
        artifactRetainedAt: new Date(),
        meta: { gitOwner: index === 1 ? "EarlierAuthor" : "Owner", composeServices: [{ name: "api", environment: { SECRET: "sensitive" } }] },
      });
      ids.push(dep.id);
    }
    await setActive(project.id, ids[44]!);
  });

  it("pages the whole history in order without repeating rows", async () => {
    const pages = await Promise.all([1, 2, 3].map((page) => listDeployments(org.organizationId, { projectId: project.id, page, perPage: 20 })));
    expect(pages.map((page) => page.rows.length)).toEqual([20, 20, 5]);
    expect(pages.every((page) => page.total === 45)).toBe(true);
    expect(pages.flatMap((page) => page.rows.map((row) => row.id))).toEqual([...ids].reverse());
  });

  it("keeps the project tab's active flag, pagination, and masking consistent", async () => {
    const response = await inspection.listDeployments!({ ...org, source: "api" } as never, project.id, { page: 1, perPage: 20 });
    expect(response.total).toBe(45);
    expect(response.data.filter((row) => row.isActive).map((row) => row.id)).toEqual([ids[44]]);
    const frozen = response.data[0]!.meta as { composeServices: Array<{ environment: Record<string, string> }> };
    expect(frozen.composeServices[0]!.environment.SECRET).toBe(ENV_MASK);
    expect(JSON.stringify(response)).not.toContain("sensitive");
  });

  it("finds failures older than the first page and counts the filtered history", async () => {
    const response = await inspection.listDeployments!({ ...org } as never, project.id, { status: "failed", page: 1, perPage: 2 });
    expect(response.total).toBe(3);
    expect(response.data.map((row) => row.id)).toEqual([ids[2], ids[1]]);
  });

  it.each([
    ["100%_literal", 1], ["100xxliteral", 0], ["earlierauthor", 1], ["00000000", 1], ["HISTORY EXAMPLE", 45],
  ])("searches all rows for the literal %s", async (search, count) => {
    const response = await listDeployments(org.organizationId, { projectId: project.id, search });
    expect(response.total).toBe(count);
  });

  it("keeps filters scoped to the current organization", async () => {
    const other = await seedOrg();
    expect((await listDeployments(other.organizationId, { search: "History example" })).total).toBe(0);
    await expect(listDeployments(other.organizationId, { projectId: project.id })).rejects.toThrow();
  });

  it("lists project filter options even when that project is not on the current page", async () => {
    const older = await seedProject(org.organizationId, { name: "Older project" });
    await seedDeployment(older, { createdAt: new Date("2020-01-01") });
    const result = await listDeployments(org.organizationId, { page: 1, perPage: 1 });
    expect(result.rows.some((row) => row.projectId === older.id)).toBe(false);
    expect(result.projects).toContainEqual({ id: older.id, name: "Older project" });
    const other = await seedOrg();
    expect((await listDeployments(other.organizationId, {})).projects).toEqual([]);
  });

  it("uses a stable tie-breaker when creation timestamps match", async () => {
    const other = await seedProject(org.organizationId);
    const createdAt = new Date("2026-01-01");
    const rows = await Promise.all([1, 2, 3].map(() => seedDeployment(other, { createdAt })));
    const pages = await Promise.all([1, 2, 3].map((page) => repos.deployment.listByProject(other.id, { page, perPage: 1 })));
    expect(pages.flatMap((page) => page.rows.map((row) => row.id))).toEqual(rows.map((row) => row.id).sort().reverse());
  });

  it("validates the same history filters and retention input for native and HTTP calls", () => {
    const filters = { status: "failed", search: "older release", page: 2, perPage: 20 };
    expect(parseInput(ListDeploymentsSchema, filters)).toEqual(filters);
    expect(parseInput(ProjectControlSchemas.listDeployments.input, filters)).toEqual(filters);
    expect(parseInput(UpdateProjectBody, { rollbackWindow: null })).toEqual({ rollbackWindow: null });
    for (const rollbackWindow of [-1, 1.5, 21]) expect(() => parseInput(UpdateProjectBody, { rollbackWindow })).toThrow();
    expect(() => parseInput(ListDeploymentsSchema, { page: 0 })).toThrow();
    expect(() => parseInput(ListDeploymentsSchema, { status: "bogus" })).toThrow();
  });
});

describe("deployment monitoring aggregates", () => {
  it("summarizes the full UTC window across pages without counting cancellations as failures", async () => {
    const org = await seedOrg();
    const project = await seedProject(org.organizationId);
    const other = await seedOrg();
    const otherProject = await seedProject(other.organizationId);
    const now = new Date();
    for (let i = 0; i < 23; i++) await seedDeployment(project, { status: "ready", createdAt: now, buildDurationMs: i === 0 ? 1000 : 3000 });
    const buildingProject = await seedProject(org.organizationId);
    for (const status of ["no_changes", "failed", "partial_failure", "action_required", "rejected", "cancelled", "queued", "building"]) {
      await seedDeployment(status === "building" ? buildingProject : project, { status, createdAt: now });
    }
    await seedDeployment(project, { status: "failed", createdAt: new Date(now.getTime() - 40 * 86400000) });
    await seedDeployment(otherProject, { status: "failed", createdAt: now });
    const result = await listDeployments(org.organizationId, { days: 7, status: "failed", perPage: 1 });
    expect(result.rows).toHaveLength(1);
    expect(result.total).toBe(4);
    expect(result.summary).toMatchObject({ total: 31, success: 24, failed: 4, active: 2, canceled: 1, avgBuildDurationMs: Math.round(67000 / 23) });
    expect(result.summary?.daily).toHaveLength(7);
    expect(result.summary?.daily.reduce((n, d) => n + d.total, 0)).toBe(31);
    expect(result.summary?.projects).toEqual([expect.objectContaining({ projectId: project.id, total: 30, failed: 4 }), expect.objectContaining({ projectId: buildingProject.id, total: 1, active: 1 })]);
    const active = await listDeployments(org.organizationId, { days: 7, status: "active" });
    expect(active.rows.map(d => d.status).sort()).toEqual(["building", "queued"]);
    const empty = await listDeployments(org.organizationId, { days: 7, search: "no-matching-release" });
    expect(empty.summary).toMatchObject({ total: 0, avgBuildDurationMs: null, projects: [] });
    expect(empty.summary?.daily.every(d => d.total === 0)).toBe(true);
    expect((await listDeployments(org.organizationId, {})).summary).toBeUndefined();
    expect(() => parseInput(ListDeploymentsSchema, { days: 91 })).toThrow();
    expect(() => parseInput(ListDeploymentsSchema, { days: 0 })).toThrow();
  });
});
