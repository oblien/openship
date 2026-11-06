import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENV_MASK } from "@repo/core";
import { repos, toComposeSpec, type Service } from "@repo/db";
import { buildDependencies } from "@repo/platform/engine/modules/deployments/build.operations";
import { resolveProjectInfo } from "@repo/platform/engine/modules/deployments/prepare.service";
import {
  assertComposeReviewed,
  composeSourceRevision,
  composeSourceChanges,
} from "@repo/platform/engine/modules/deployments/compose-review";
import { seedOrg, seedProject, seedDeployment, seedServiceDeployment } from "../../helpers/seed";
import { parseComposeFile } from "@repo/platform/engine/lib/compose-parser";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Compose source review and synchronization", () => {
  it("compares authored commands across unresolved values and one-time provenance migration", async () => {
    const org = await seedOrg();
    const project = await seedProject(org.organizationId, { framework: "docker-compose" });
    const source = 'services:\n  api:\n    image: busybox\n    command: [echo, "${VALUE}"]\n';
    const initial = parseComposeFile(source).services;
    const saved = await repos.service.syncFromCompose(project.id, initial, { composeAuthoritative: true });
    const resolved = parseComposeFile(source, { env: { VALUE: "now set" } }).services;
    expect(composeSourceChanges(saved, resolved).changed).toEqual([]);
    expect(composeSourceRevision(project.id, initial)).toBe(composeSourceRevision(project.id, resolved));
    const legacy = { ...saved[0]!, importedSpec: { ...saved[0]!.importedSpec!, advanced: {} } };
    expect(composeSourceChanges([legacy], resolved).changed).toEqual([]);
    const edited = parseComposeFile(source.replace("[echo,", "[printf,")).services;
    expect(composeSourceChanges(saved, edited).changed).toEqual(["api"]);
  });
  it("changing a command variable does not invent a Compose source edit", () => {
    const source = 'services:\n  redis:\n    image: redis:7\n    command: [redis-server, --requirepass, "${REDIS_PASSWORD}"]\n';
    const before = parseComposeFile(source, { env: { REDIS_PASSWORD: "before" } }).services;
    const after = parseComposeFile(source, { env: { REDIS_PASSWORD: "after" } }).services;
    expect(composeSourceRevision("project-review", before)).toBe(composeSourceRevision("project-review", after));
  });
  it("previews add/change/remove without writes, then archives removed containers for the existing reaper", async () => {
    const org = await seedOrg({ ownsHost: true });
    const localPath = await mkdtemp(join(tmpdir(), "compose-review-"));
    dirs.push(localPath);
    const project = await seedProject(org.organizationId, {
      framework: "docker-compose",
      localPath,
      composePath: "compose.yml",
    });
    const original = [
      { name: "db", image: "postgres:16", environment: { PASSWORD: "source-secret" } },
      {
        name: "old-worker",
        image: "busybox",
        environment: { TOKEN: "saved-secret" },
        volumes: ["data:/data"],
      },
    ];
    const saved = await repos.service.syncFromCompose(project.id, original, {
      composeAuthoritative: true,
    });
    const db = saved.find((s) => s.name === "db")!;
    const retired = saved.find((s) => s.name === "old-worker")!;
    await repos.service.update(db.id, {
      environment: { PASSWORD: "operator-secret" },
      exposed: true,
      publicEndpoints: [{ port: 5432, domainType: "custom", customDomain: "db.example.test" }],
    });
    const active = await seedDeployment({ id: project.id, organizationId: org.organizationId });
    await seedServiceDeployment(active.id, retired, { containerId: "old-worker-container" });
    const before = await repos.service.listByProject(project.id);
    await writeFile(
      join(localPath, "compose.yml"),
      [
        "services:",
        "  db:",
        "    image: postgres:17",
        "    environment:",
        "      PASSWORD: source-secret",
        "  worker:",
        "    image: busybox",
        "    environment:",
        "      API_TOKEN: '${API_TOKEN:?Configure a token}'",
      ].join("\n"),
    );
    const input = {
      source: "local" as const,
      path: localPath,
      composePath: "compose.yml",
      projectId: project.id,
    };
    const ctx = { organizationId: org.organizationId, userId: org.userId } as Parameters<
      typeof buildDependencies.prepare
    >[0];
    const preview = await buildDependencies.prepare(ctx, input);
    expect(preview.composeChanges).toEqual({
      added: ["worker"],
      changed: ["db"],
      removed: ["old-worker"],
    });
    expect(preview.services).toEqual([
      expect.objectContaining({
        name: "db",
        image: "postgres:17",
        serviceId: db.id,
        environment: { PASSWORD: ENV_MASK },
        publicEndpoints: [{ port: 5432, domainType: "custom", customDomain: "db.example.test" }],
      }),
      expect.objectContaining({ name: "worker", environment: { API_TOKEN: "" } }),
    ]);
    // Cancel is just closing the preview: it never advances the baseline or the desired set.
    expect(await repos.service.listByProject(project.id)).toEqual(before);
    expect(JSON.stringify(preview)).not.toContain("operator-secret");
    expect(
      JSON.stringify(await buildDependencies.prepare(ctx, { ...input, includeEnv: true })),
    ).not.toContain("operator-secret");
    const source = (await resolveProjectInfo(input)).services!;
    expect(() => assertComposeReviewed(project.id, before, source)).toThrowError(
      expect.objectContaining({ code: "COMPOSE_REVIEW_REQUIRED" }),
    );
    assertComposeReviewed(project.id, before, source, preview.composeRevision as string);
    await repos.service.reconcileFromCompose(project.id, source);
    expect((await repos.service.listByProject(project.id)).map((s) => s.name).sort()).toEqual([
      "db",
      "worker",
    ]);
    expect((await repos.service.findById(db.id))?.environment).toEqual({
      PASSWORD: "operator-secret",
    });
    expect(await repos.service.findById(retired.id)).toMatchObject({
      archivedAt: expect.any(Date),
      environment: { TOKEN: "saved-secret" },
      volumes: ["data:/data"],
    });
    expect(await repos.service.listByDeployment(active.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ serviceId: retired.id, containerId: "old-worker-container" }),
      ]),
    );
    const current = await repos.service.listByProject(project.id);
    expect(() => assertComposeReviewed(project.id, current, source)).not.toThrow();
    await repos.service.reconcileFromCompose(project.id, source);
    expect(await repos.service.listByProject(project.id)).toEqual(current);
    // Frozen snapshots revive the original identity, preserving history and data.
    await repos.service.syncFromCompose(project.id, original, { removeMissing: false });
    expect(await repos.service.findById(retired.id)).toMatchObject({
      archivedAt: null,
      environment: { TOKEN: "saved-secret" },
    });
    expect(
      (await repos.service.listByProject(project.id, { includeArchived: true })).filter(
        (s) => s.name === retired.name,
      ),
    ).toHaveLength(1);
  });

  it("does not revive an old identity over a current service that reused its name", async () => {
    const org = await seedOrg();
    const project = await seedProject(org.organizationId, { framework: "docker-compose" });
    const [old] = await repos.service.syncFromCompose(
      project.id,
      [{ name: "worker", image: "busybox" }],
      { composeAuthoritative: true },
    );
    await repos.service.reconcileFromCompose(project.id, []);
    const current = await repos.service.create({
      projectId: project.id,
      name: "worker",
      image: "alpine",
      sortOrder: -1,
    });
    await repos.service.reconcileFromCompose(project.id, [{ name: "worker", image: "busybox" }]);
    await repos.service.syncFromCompose(project.id, [{ name: "worker", image: "alpine" }], {
      removeMissing: false,
    });
    expect((await repos.service.listByProject(project.id)).map((service) => service.id)).toEqual([
      current.id,
    ]);
    expect((await repos.service.findById(old!.id))?.archivedAt).toBeInstanceOf(Date);
  });

  it("binds review to the source and project, ignoring service/map order and image interpolation", () => {
    const source = [
      {
        name: "api",
        image: "api:1",
        environment: { B: "2", A: "1" },
        advanced: {
          imageTemplate: {
            expression: "api:${VERSION}",
            unresolvedVariables: [],
            sourceValue: "api:1",
          },
        },
      },
      { name: "db", image: "postgres:16" },
    ];
    const rows = source.map((s) => ({
      ...s,
      kind: "compose",
      importedSpec: toComposeSpec(s),
    })) as Service[];
    const revision = composeSourceRevision("project", source);
    const resolved = [
      source[1]!,
      { ...source[0]!, image: "api:2", environment: { A: "1", B: "2" } },
    ];
    expect(composeSourceRevision("project", resolved)).toBe(revision);
    expect(() => assertComposeReviewed("project", rows, resolved)).not.toThrow();
    expect(() => assertComposeReviewed("other-project", rows, source, revision)).toThrow();
    expect(() =>
      assertComposeReviewed(
        "project",
        rows,
        [...source, { name: "new", image: "busybox" }],
        revision,
      ),
    ).toThrow();
    expect(() => assertComposeReviewed("project", rows, [source[0]!], revision)).toThrow();
    expect(() =>
      assertComposeReviewed(
        "project",
        rows,
        [{ ...source[0]!, command: "new-command" }, source[1]!],
        revision,
      ),
    ).toThrow();
  });
});
