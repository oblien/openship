import { describe, expect, it } from "vitest";
import { repos } from "@repo/db";
import { seedOrg, seedProject, seedService } from "../../helpers/seed";
import {
  ensureProject,
  updateOptions,
  updateProject,
} from "@repo/platform/engine/modules/projects/project-crud.service";

describe("saved build commands", () => {
  async function fixture(overrides: Record<string, unknown> = {}) {
    const owner = await seedOrg();
    const project = await seedProject(owner.organizationId, {
      framework: "nextjs",
      packageManager: "npm",
      hasBuild: true,
      hasServer: true,
      installCommand: "npm ci",
      buildCommand: "npm run build",
      startCommand: "npm start",
      ...overrides,
    });
    return { owner, project };
  }

  it.each(["options", "update", "ensure"] as const)(
    "%s refuses blank required commands before saving any fields",
    async (entry) => {
      const { owner, project } = await fixture();
      const apply = (patch: Record<string, unknown>) =>
        entry === "options"
          ? updateOptions(project.id, patch, owner.organizationId)
          : entry === "update"
            ? updateProject(project.id, patch, owner.organizationId)
            : ensureProject(
                { projectId: project.id, name: project.name, ...patch },
                owner.organizationId,
              );
      for (const field of ["installCommand", "startCommand"] as const) {
        for (const blank of ["", " \n\t "]) {
          await expect(apply({ [field]: blank, buildCommand: "changed" })).rejects.toThrow(
            /command.*empty/i,
          );
          expect(await repos.project.findById(project.id)).toMatchObject({
            installCommand: "npm ci",
            startCommand: "npm start",
            buildCommand: "npm run build",
          });
        }
      }
    },
  );

  it("keeps unrelated legacy edits possible and allows an explicit repair", async () => {
    const { owner, project } = await fixture({ installCommand: "" });
    await updateOptions(
      project.id,
      { buildCommand: "npm run build:production" },
      owner.organizationId,
    );
    await updateOptions(project.id, { installCommand: "npm ci" }, owner.organizationId);
    expect(await repos.project.findById(project.id)).toMatchObject({
      installCommand: "npm ci",
      buildCommand: "npm run build:production",
    });
  });

  it.each(["docker", "docker-compose"])("allows image-owned commands for %s", async (framework) => {
    const { owner, project } = await fixture({ framework });
    await updateOptions(project.id, { installCommand: "", startCommand: "" }, owner.organizationId);
    expect(await repos.project.findById(project.id)).toMatchObject({
      installCommand: "",
      startCommand: "",
    });
  });

  it("allows disabling the build and using a static workload in the same save", async () => {
    const { owner, project } = await fixture();
    await updateOptions(
      project.id,
      { hasBuild: false, workloadType: "static", installCommand: "", startCommand: "" },
      owner.organizationId,
    );
    expect(await repos.project.findById(project.id)).toMatchObject({
      hasBuild: false,
      installCommand: "",
      startCommand: "",
    });
  });

  it("leaves monorepo commands on their service rows", async () => {
    const { owner, project } = await fixture();
    await seedService(project.id, {
      name: "web",
      kind: "monorepo",
      rootDirectory: "apps/web",
      installCommand: "npm ci",
      startCommand: "npm start",
    });
    await updateOptions(project.id, { installCommand: "", startCommand: "" }, owner.organizationId);
    expect(await repos.project.findById(project.id)).toMatchObject({
      installCommand: "",
      startCommand: "",
    });
  });

  it("does not let a disabled monorepo service bypass primary-app validation", async () => {
    const { owner, project } = await fixture();
    await seedService(project.id, {
      name: "disabled-web",
      kind: "monorepo",
      rootDirectory: "apps/web",
      enabled: false,
    });
    await expect(
      updateOptions(project.id, { installCommand: "" }, owner.organizationId),
    ).rejects.toThrow(/command.*empty/i);
    expect((await repos.project.findById(project.id))?.installCommand).toBe("npm ci");
  });

  it.each(["monorepo", "services"] as const)(
    "does not let a %s hint without service recipes bypass validation",
    async (projectType) => {
      const { owner, project } = await fixture();
      await expect(
        ensureProject(
          { projectId: project.id, name: project.name, projectType, installCommand: "" },
          owner.organizationId,
        ),
      ).rejects.toThrow(/command.*empty/i);
      expect((await repos.project.findById(project.id))?.installCommand).toBe("npm ci");
    },
  );

  it.each([false, true])(
    "does not let disabled incoming apps bypass validation (previous active app: %s)",
    async (previousApp) => {
      const { owner, project } = await fixture();
      if (previousApp)
        await seedService(project.id, { name: "web", kind: "monorepo", enabled: true });
      await expect(
        ensureProject(
          {
            projectId: project.id,
            name: project.name,
            projectType: "monorepo",
            installCommand: "",
            monorepoApps: [{ name: "web", rootDirectory: "apps/web", enabled: false }],
          },
          owner.organizationId,
        ),
      ).rejects.toThrow(/command.*empty/i);
      expect((await repos.project.findById(project.id))?.installCommand).toBe("npm ci");
      if (previousApp)
        expect((await repos.service.listByProject(project.id))[0]?.enabled).toBe(true);
    },
  );

  it.each(["monorepo", "services"] as const)(
    "allows incoming %s recipes to own their commands",
    async (projectType) => {
      const { owner, project } = await fixture();
      await ensureProject(
        {
          projectId: project.id,
          name: project.name,
          projectType,
          installCommand: "",
          startCommand: "",
          ...(projectType === "monorepo"
            ? {
                monorepoApps: [
                  {
                    name: "web",
                    rootDirectory: "apps/web",
                    framework: "nextjs",
                    installCommand: "npm ci",
                    startCommand: "npm start",
                  },
                ],
              }
            : { services: [{ name: "web", image: "nginx:alpine" }] }),
        },
        owner.organizationId,
      );
      expect(
        (await repos.service.listByProject(project.id)).map((service) => service.name),
      ).toContain("web");
    },
  );

  it("does not let an added image service disable primary-app validation", async () => {
    const { owner, project } = await fixture();
    await seedService(project.id, { name: "redis", image: "redis:7" });
    await expect(
      updateOptions(project.id, { installCommand: "" }, owner.organizationId),
    ).rejects.toThrow(/command.*empty/i);
  });

  it("does not exempt a materialized primary-app row", async () => {
    const { owner, project } = await fixture();
    await seedService(project.id, { name: project.slug, kind: "monorepo", sortOrder: -1 });
    await expect(
      updateOptions(project.id, { installCommand: "" }, owner.organizationId),
    ).rejects.toThrow(/command.*empty/i);
  });

  it("checks ownership before examining or changing build settings", async () => {
    const { project } = await fixture();
    const outsider = await seedOrg();
    await expect(
      updateOptions(project.id, { installCommand: "npm install" }, outsider.organizationId),
    ).rejects.toThrow(/not found/i);
    expect((await repos.project.findById(project.id))?.installCommand).toBe("npm ci");
  });
});
