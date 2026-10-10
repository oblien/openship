import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { generateId } from "@repo/core";
import { createDatabase, type DatabaseConnection } from "../factory";
import * as schema from "../schema";
import { createActionsRepo } from "./actions.repo";

let connection: DatabaseConnection;
let repo: ReturnType<typeof createActionsRepo>;
beforeAll(async () => {
  connection = await createDatabase({ driver: "pglite", dataDir: "memory://" });
  repo = createActionsRepo(connection.db);
});
afterAll(() => connection.close());

async function fixture() {
  const org = generateId("org"),
    projectId = generateId("proj"),
    groupId = generateId("group");
  await connection.db.insert(schema.organization).values({ id: org, name: org });
  await connection.db
    .insert(schema.projectGroup)
    .values({ id: groupId, organizationId: org, name: "Test", slug: groupId });
  await connection.db
    .insert(schema.project)
    .values({ id: projectId, groupId, organizationId: org, name: "Test", slug: projectId });
  const entry = (id: string) => ({
    value: {
      id,
      organizationId: org,
      name: id,
      owner: "acme",
      repo: "app",
      ref: "main",
      path: `.github/workflows/${id}.yml`,
      controller: "github" as const,
      githubWorkflowId: id,
      source: null,
      definition: { name: id, jobs: [], triggers: { workflow_dispatch: {} } },
      runnerIds: ["runner"],
      enabled: true,
      authority: {
        version: 1 as const,
        userId: "test",
        organizationId: org,
        token: null,
        restrictions: null,
      },
    },
    createOnly: true,
    projectIds: [projectId],
  });
  return { org, projectId, groupId, entry };
}

describe("transactional workflow imports", () => {
  it("imports all files and project links, including concurrent retries without duplicates", async () => {
    const f = await fixture();
    const entries = [f.entry(generateId("awf")), f.entry(generateId("awf"))];
    const [first, retry] = await Promise.all([
      repo.saveWorkflows(entries),
      repo.saveWorkflows(entries),
    ]);
    expect(first.map((row) => row.id)).toEqual(retry.map((row) => row.id));
    expect(await repo.listWorkflows(f.org)).toHaveLength(2);
    expect(await repo.projectWorkflows(f.org, f.projectId)).toHaveLength(2);
  });

  it("preserves existing settings and required links when importing for another project", async () => {
    const f = await fixture(),
      id = generateId("awf");
    await repo.saveWorkflows([f.entry(id)]);
    const saved = (await repo.workflow(f.org, id))!;
    await repo.saveWorkflow({ ...saved, name: "Renamed", enabled: false });
    await connection.db
      .update(schema.actionProject)
      .set({ required: true })
      .where(eq(schema.actionProject.workflowId, id));
    const projectId = generateId("proj");
    await connection.db.insert(schema.project).values({
      id: projectId,
      groupId: f.groupId,
      organizationId: f.org,
      name: "Second",
      slug: projectId,
      environmentSlug: "staging",
    });
    const [imported] = await repo.saveWorkflows([
      { ...f.entry(id), projectIds: [f.projectId, projectId] },
    ]);
    expect(imported).toMatchObject({ name: "Renamed", enabled: false });
    expect(await repo.workflowProjects(f.org, id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ projectId: f.projectId, required: true }),
        expect.objectContaining({ projectId, required: false }),
      ]),
    );
  });

  it("rolls back earlier files and links if a later write fails ownership validation", async () => {
    const f = await fixture(),
      other = await fixture();
    const first = f.entry(generateId("aaa")),
      conflicting = other.entry(generateId("zzz"));
    await repo.saveWorkflows([conflicting]);
    await expect(repo.saveWorkflows([first, f.entry(conflicting.value.id)])).rejects.toMatchObject({
      code: "ACTIONS_WORKFLOW_NOT_FOUND",
    });
    expect(await repo.listWorkflows(f.org)).toHaveLength(0);
    expect(await repo.projectWorkflows(f.org, f.projectId)).toHaveLength(0);
    expect(await repo.workflow(other.org, conflicting.value.id)).toBeDefined();
  });

  it("refuses to attach projects when a concurrent write changed the authorized destinations", async () => {
    const f = await fixture();
    const stale = f.entry(generateId("awf"));
    await repo.saveWorkflows([
      { ...stale, value: { ...stale.value, runnerIds: ["another-runner"] }, projectIds: [] },
    ]);
    await expect(repo.saveWorkflows([stale])).rejects.toMatchObject({
      code: "ACTIONS_WORKFLOW_CHANGED",
    });
    expect(await repo.projectWorkflows(f.org, f.projectId)).toHaveLength(0);
    expect(await repo.workflow(f.org, stale.value.id)).toMatchObject({
      runnerIds: ["another-runner"],
    });
  });

  it("rejects deleting or foreign projects before inserting any workflow", async () => {
    const f = await fixture(),
      other = await fixture();
    const entry = f.entry(generateId("awf"));
    await expect(
      repo.saveWorkflows([{ ...entry, projectIds: [other.projectId] }]),
    ).rejects.toMatchObject({ code: "PROJECT_UNAVAILABLE" });
    await connection.db
      .update(schema.project)
      .set({ deletionInProgress: true })
      .where(eq(schema.project.id, f.projectId));
    await expect(repo.saveWorkflows([entry])).rejects.toMatchObject({
      code: "PROJECT_UNAVAILABLE",
    });
    expect(await repo.listWorkflows(f.org)).toHaveLength(0);
  });
});
