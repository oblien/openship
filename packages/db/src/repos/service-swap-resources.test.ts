import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, createRepositories, schema, type DatabaseConnection } from "../factory";
import { createEncryption } from "../encryption";

describe("service swap and inherited memory stay valid together", () => {
  const encryption = createEncryption("swap-resource-test");
  let connection: DatabaseConnection;
  let repos: ReturnType<typeof createRepositories>;
  let sequence = 0;
  beforeAll(async () => {
    connection = await createDatabase({ driver: "pglite", dataDir: "memory://" });
    repos = createRepositories(connection.db, encryption);
    await connection.db.insert(schema.organization).values({ id: "org", name: "Test" });
  });
  afterAll(async () => {
    await connection?.close();
    encryption.close();
  });
  async function fixture(memoryMb = 1024) {
    const slug = `swap-${++sequence}`;
    const group = await repos.projectGroup.create({ organizationId: "org", name: slug, slug });
    const project = await repos.project.create({
      groupId: group.id,
      organizationId: "org",
      name: slug,
      slug,
      resources: { memoryMb },
    });
    return { project, group };
  }
  const disabled = { resources: { swapDisabled: true } };
  const invalid = { code: "SWAP_DISABLED_REQUIRES_MEMORY_LIMIT", statusCode: 400 };

  it.each([null, { memoryMb: 0 }])(
    "rejects removing inherited memory atomically (%j)",
    async (resources) => {
      const { project } = await fixture();
      const service = await repos.service.create({
        projectId: project.id,
        name: "vault",
        advanced: disabled,
      });
      await expect(
        repos.project.update(project.id, { resources, name: "must-not-save" }),
      ).rejects.toMatchObject(invalid);
      expect(await repos.project.findById(project.id)).toMatchObject({
        name: project.name,
        resources: { memoryMb: 1024 },
      });
      expect((await repos.service.findById(service.id))?.advanced).toEqual(disabled);
    },
  );
  it("validates app-wide project updates before changing any environment", async () => {
    const { project, group } = await fixture();
    const other = await repos.project.create({
      groupId: group.id,
      organizationId: "org",
      name: "preview",
      environmentSlug: "preview",
      slug: `preview-${sequence}`,
      resources: { memoryMb: 1024 },
    });
    await repos.service.create({ projectId: other.id, name: "vault", advanced: disabled });
    await expect(repos.project.updateByApp(group.id, { resources: null })).rejects.toMatchObject(
      invalid,
    );
    await expect(
      repos.project.updateSourceByApp(group.id, { resources: null }, { name: "must-not-save" }),
    ).rejects.toMatchObject(invalid);
    expect((await repos.projectGroup.findById(group.id))?.name).toBe(group.name);
    for (const id of [project.id, other.id])
      expect((await repos.project.findById(id))?.resources).toEqual({ memoryMb: 1024 });
  });
  it("accepts a service-owned memory cap and does not constrain ordinary services", async () => {
    const { project } = await fixture();
    await repos.service.create({
      projectId: project.id,
      name: "vault",
      advanced: { resources: { memoryMb: 128, swapDisabled: true } },
    });
    await repos.service.create({ projectId: project.id, name: "web" });
    await repos.project.update(project.id, { resources: null });
    expect((await repos.project.findById(project.id))?.resources).toBeNull();
  });
  it("rejects invalid direct service create, update, and project moves", async () => {
    const { project } = await fixture(0);
    await expect(
      repos.service.create({ projectId: project.id, name: "vault", advanced: disabled }),
    ).rejects.toMatchObject(invalid);
    expect(await repos.service.listByProject(project.id)).toHaveLength(0);
    const service = await repos.service.create({ projectId: project.id, name: "vault" });
    await expect(
      repos.service.update(service.id, { advanced: disabled, name: "must-not-save" }),
    ).rejects.toMatchObject(invalid);
    expect((await repos.service.findById(service.id))?.name).toBe("vault");
    const source = await fixture();
    const inherited = await repos.service.create({
      projectId: source.project.id,
      name: "vault",
      advanced: disabled,
    });
    await expect(
      repos.service.update(inherited.id, { projectId: project.id }),
    ).rejects.toMatchObject(invalid);
    expect((await repos.service.findById(inherited.id))?.projectId).toBe(source.project.id);
  });
  it("validates Compose memory edits and lets an explicit opt-out replace a stored true", async () => {
    const { project } = await fixture(0);
    const [original] = await repos.service.syncFromCompose(project.id, [
      {
        name: "vault",
        image: "example/vault:1",
        advanced: { resources: { memoryMb: 1024, swapDisabled: true } },
      },
    ]);
    await expect(
      repos.service.syncFromCompose(project.id, [
        { name: "vault", advanced: { resources: { memoryMb: 0 } } },
      ]),
    ).rejects.toMatchObject(invalid);
    expect((await repos.service.findById(original!.id))?.advanced?.resources).toEqual({
      memoryMb: 1024,
      swapDisabled: true,
    });
    const [off] = await repos.service.syncFromCompose(project.id, [
      { name: "vault", advanced: { resources: { memoryMb: 0, swapDisabled: false } } },
    ]);
    expect(off!.advanced?.resources).toEqual({ memoryMb: 0, swapDisabled: false });
  });
  it("preserves the opt-in across Compose sync that omits the setting", async () => {
    const { project } = await fixture();
    await repos.service.create({ projectId: project.id, name: "vault", advanced: disabled });
    const [service] = await repos.service.syncFromCompose(
      project.id,
      [{ name: "vault", advanced: { resources: { memoryMb: 512 } } }],
      { composeAuthoritative: true },
    );
    expect(service!.advanced?.resources).toEqual({ memoryMb: 512, swapDisabled: true });
  });
  it("serializes concurrent service opt-in and removal of project memory", async () => {
    const { project } = await fixture();
    const service = await repos.service.create({ projectId: project.id, name: "vault" });
    const outcomes = await Promise.allSettled([
      repos.service.update(service.id, { advanced: disabled }),
      repos.project.update(project.id, { resources: null }),
    ]);
    expect(outcomes.filter((value) => value.status === "rejected")).toHaveLength(1);
    const stored = await repos.service.findById(service.id);
    const parent = await repos.project.findById(project.id);
    if (stored?.advanced?.resources?.swapDisabled)
      expect(parent?.resources).toEqual({ memoryMb: 1024 });
  });
});
