import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repos } from "@repo/db";
import { parseInput, EnsureProjectBody, SetOptionsBody } from "@repo/contracts";
import { seedOrg, seedProject } from "../../helpers/seed";
import {
  updateOptions,
  updateProject,
  ensureProject,
  createProject,
} from "@repo/platform/engine/modules/projects/project-crud.service";
import { buildConfigSnapshot } from "@repo/platform/engine/modules/deployments/build.service";
import {
  resolveProjectInfo,
  projectInfoToScanResponse,
} from "@repo/platform/engine/modules/deployments/prepare.service";

describe("project PHP settings across configuration surfaces", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });
  async function fixture() {
    const owner = await seedOrg();
    const project = await seedProject(owner.organizationId, {
      framework: "laravel",
      buildImage: "php:8.4-cli",
      runtimeMode: "docker",
      hasServer: true,
    });
    return { owner, project };
  }

  it.each(["options", "update", "ensure"])(
    "persists %s and resolves the snapshot from the saved version",
    async (entry) => {
      const { owner, project } = await fixture();
      if (entry === "options")
        await updateOptions(
          project.id,
          parseInput(SetOptionsBody, { runtimeVersion: "8.3" }),
          owner.organizationId,
        );
      if (entry === "update")
        await updateProject(project.id, { runtimeVersion: "8.3" }, owner.organizationId);
      if (entry === "ensure")
        await ensureProject(
          parseInput(EnsureProjectBody, {
            projectId: project.id,
            name: project.name,
            runtimeVersion: "8.3",
          }),
          owner.organizationId,
        );
      const saved = (await repos.project.findById(project.id))!;
      expect(saved).toMatchObject({ runtimeVersion: "8.3", buildImage: "php:8.3-cli-bookworm" });
      const frozen = buildConfigSnapshot(saved);
      expect(frozen).toMatchObject({
        runtimeVersion: "8.3",
        buildImage: "php:8.3-cli-bookworm",
        runtimeImage: "dunglas/frankenphp:1-php8.3-bookworm",
      });
      await updateOptions(project.id, { runtimeVersion: "8.4" }, owner.organizationId);
      expect(frozen.runtimeVersion).toBe("8.3");
      expect(frozen.runtimeImage).toBe("dunglas/frankenphp:1-php8.3-bookworm");
    },
  );
  it("leaves old projects unchanged and refuses invalid changes before writes", async () => {
    const { owner, project } = await fixture();
    expect(buildConfigSnapshot(project)).toMatchObject({
      buildImage: "php:8.4-cli",
      runtimeImage: "dunglas/frankenphp:1-php8.4-bookworm",
    });
    expect(buildConfigSnapshot(project)).not.toHaveProperty("runtimeVersion");
    await expect(
      updateOptions(
        project.id,
        { runtimeVersion: "8.5", buildCommand: "changed" },
        owner.organizationId,
      ),
    ).rejects.toThrow(/Unsupported runtimeVersion/);
    expect((await repos.project.findById(project.id))?.buildCommand).toBe(project.buildCommand);
    await updateOptions(project.id, { runtimeVersion: "8.3" }, owner.organizationId);
    await expect(
      updateOptions(
        project.id,
        { runtimeMode: "bare", buildCommand: "changed" },
        owner.organizationId,
      ),
    ).rejects.toThrow(/generated PHP Docker/);
    await expect(
      updateOptions(project.id, { buildImage: "php:8.4-cli" }, owner.organizationId),
    ).rejects.toThrow(/uses PHP 8.4/);
    expect(await repos.project.findById(project.id)).toMatchObject({
      runtimeMode: "docker",
      buildImage: "php:8.3-cli-bookworm",
      buildCommand: project.buildCommand,
    });
  });
  it("validates a generic contract against the project runtime before any update", async () => {
    const { owner, project } = await fixture();
    expect(parseInput(SetOptionsBody, { runtimeVersion: "22" })).toEqual({ runtimeVersion: "22" });
    expect(() => parseInput(SetOptionsBody, { runtimeVersion: "8.3\nFROM evil" })).toThrow();
    await updateOptions(project.id, { runtimeVersion: "8.3" }, owner.organizationId);
    await expect(
      updateProject(
        project.id,
        { framework: "node", buildCommand: "changed" },
        owner.organizationId,
      ),
    ).rejects.toThrow(/not supported for node/);
    expect(await repos.project.findById(project.id)).toMatchObject({
      framework: "laravel",
      runtimeVersion: "8.3",
      buildCommand: project.buildCommand,
    });
    await updateProject(
      project.id,
      { framework: "node", runtimeVersion: null, buildImage: "node:22" },
      owner.organizationId,
    );
    expect(await repos.project.findById(project.id)).toMatchObject({
      framework: "node",
      runtimeVersion: null,
      buildImage: "node:22",
    });
    await expect(
      updateOptions(
        project.id,
        { runtimeVersion: "22", buildCommand: "changed" },
        owner.organizationId,
      ),
    ).rejects.toThrow(/not supported for node/);
    expect((await repos.project.findById(project.id))?.buildCommand).toBe(project.buildCommand);
  });
  it("refuses an incompatible builder before creating a project group", async () => {
    const owner = await seedOrg();
    const before = await repos.projectGroup.listByOrganization(owner.organizationId);
    await expect(
      createProject(
        {
          name: "invalid-php",
          framework: "laravel",
          runtimeVersion: "8.3",
          buildImage: "php:8.4-cli",
        },
        owner.organizationId,
      ),
    ).rejects.toThrow(/uses PHP 8.4/);
    expect(await repos.projectGroup.listByOrganization(owner.organizationId)).toEqual(before);
  });
  it("carries repository selection into public scans and rejects invalid declarations", async () => {
    const path = await mkdtemp(join(tmpdir(), "openship-php-scan-"));
    directories.push(path);
    await writeFile(join(path, "artisan"), "<?php");
    await writeFile(
      join(path, "composer.json"),
      JSON.stringify({ require: { "laravel/framework": "^12.0" } }),
    );
    await writeFile(join(path, "openship.json"), JSON.stringify({ runtimeVersion: "8.3" }));
    const info = await resolveProjectInfo({ source: "local", path });
    expect(projectInfoToScanResponse(info)).toMatchObject({
      runtimeVersion: "8.3",
      buildImage: "php:8.3-cli-bookworm",
    });
    await writeFile(join(path, "openship.json"), JSON.stringify({ runtimeVersion: "8.5" }));
    await expect(resolveProjectInfo({ source: "local", path })).rejects.toThrow(/runtimeVersion/);
    await writeFile(
      join(path, "openship.json"),
      JSON.stringify({ runtimeVersion: "8.3", runtime: "bare" }),
    );
    await expect(resolveProjectInfo({ source: "local", path })).rejects.toThrow(
      /generated PHP Docker/,
    );
  });
  it.each(["options", "update", "ensure"])(
    "atomically persists and clears a runtime override through %s",
    async (entry) => {
      const { owner, project } = await fixture();
      async function apply(input: Record<string, unknown>) {
        if (entry === "options") return updateOptions(project.id, input, owner.organizationId);
        if (entry === "update") return updateProject(project.id, input, owner.organizationId);
        return ensureProject(
          parseInput(EnsureProjectBody, { projectId: project.id, name: project.name, ...input }),
          owner.organizationId,
        );
      }
      await apply({ runtimeVersion: "8.3", runtimeImage: "custom/runtime:83" });
      const saved = (await repos.project.findById(project.id))!;
      const frozen = buildConfigSnapshot(saved);
      expect(frozen).toMatchObject({
        runtimeImage: "custom/runtime:83",
        runtimeImageOverride: true,
        runtimeVersion: "8.3",
      });
      await expect(
        apply({ runtimeImage: "dunglas/frankenphp:1-php8.4-bookworm", buildCommand: "changed" }),
      ).rejects.toThrow(/uses PHP 8.4/);
      expect(await repos.project.findById(project.id)).toEqual(saved);
      await expect(
        apply({ runtimeImage: "custom/runtime:83\nFROM bad", buildCommand: "changed" }),
      ).rejects.toThrow(/valid Docker image/);
      expect(await repos.project.findById(project.id)).toEqual(saved);
      await apply({ runtimeVersion: "8.4", runtimeImage: null });
      expect((await repos.project.findById(project.id))?.runtimeImage).toBeNull();
      expect(frozen.runtimeImage).toBe("custom/runtime:83");
      expect(buildConfigSnapshot((await repos.project.findById(project.id))!).runtimeImage).toBe(
        "dunglas/frankenphp:1-php8.4-bookworm",
      );
    },
  );
  it("validates an override before creating a project group", async () => {
    const owner = await seedOrg();
    const before = await repos.projectGroup.listByOrganization(owner.organizationId);
    await expect(
      createProject(
        {
          name: "bad-runtime",
          framework: "laravel",
          runtimeVersion: "8.3",
          runtimeImage: "php:8.3-fpm",
        },
        owner.organizationId,
      ),
    ).rejects.toThrow(/FrankenPHP/);
    expect(await repos.projectGroup.listByOrganization(owner.organizationId)).toEqual(before);
  });
});
