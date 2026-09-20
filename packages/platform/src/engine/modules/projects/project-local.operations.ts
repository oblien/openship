import { stat } from "node:fs/promises";
import { AppError, NotFoundError } from "@repo/core";
import type { ProjectDependencies } from "../../../projects";
import type { EnsureProjectInput } from "@repo/contracts";
import type { ExecutionContext } from "../../../context";
import { validateSourceDirectory } from "../../../source-files";
import { assertNativeSourcePath } from "../../native/source-policy";
import { env } from "../../config";
import { authorization } from "../../lib/authorization";
import * as prepareService from "../deployments/prepare.service";
import * as projectService from "./project.service";

function requireLocalProjects() {
  if (env.CLOUD_MODE) throw new NotFoundError("Operation");
}

async function localDirectory(path: string): Promise<string> {
  requireLocalProjects();
  const info = await stat(path).catch(() => null);
  if (!info) throw new NotFoundError("Directory");
  if (!info.isDirectory()) throw new AppError("Path is not a directory", 400, "INVALID_SOURCE_PATH");
  if (process.env.OPENSHIP_NATIVE !== "true") return path;
  const canonical = await assertNativeSourcePath(path);
  return validateSourceDirectory(canonical);
}

/** Preserve scanner metadata and use the same creation policy/atomic token grant as projects.create. */
export function createProjectLocalDependencies(create: (ctx: ExecutionContext, input: EnsureProjectInput) => Promise<unknown>): NonNullable<ProjectDependencies["local"]> {
  return {
    async scan(_ctx, input) {
      const directory = await localDirectory(input.path);
      const info = await prepareService.resolveProjectInfo({ source: "local", path: directory });
      return { success: true, path: input.path, ...prepareService.projectInfoToScanResponse(info, input) };
    },
    async import(ctx, input) {
      const body = { ...input, localPath: await localDirectory(input.localPath) };
      // Retain all inferred Compose, monorepo, routing and build fields from the HTTP import.
      const info = await prepareService.resolveProjectInfo({ source: "local", path: body.localPath, composePath: body.composePath });
      const project = await create(ctx, {
      ...body,
      localPath: body.localPath,
      gitProvider: "local",
      framework: body.framework ?? info.stack,
      packageManager: body.packageManager ?? info.packageManager,
      installCommand: body.installCommand ?? info.installCommand,
      buildCommand: body.buildCommand ?? info.buildCommand,
      outputDirectory: body.outputDirectory ?? info.outputDirectory,
      productionPaths: body.productionPaths ?? info.productionPaths.join(", "),
      volumes: body.volumes ?? info.volumes,
      rootDirectory: body.rootDirectory ?? info.rootDirectory,
      composePath: body.composePath ?? info.composePath,
      startCommand: body.startCommand ?? info.startCommand,
      buildImage: body.buildImage ?? info.buildImage,
      productionMode: body.productionMode ?? info.productionMode,
      workloadType: body.workloadType ?? info.workloadType,
      port: body.port ?? info.port,
      hasBuild:
        body.hasBuild ??
        Boolean(info.buildCommand || info.services?.some((service) => Boolean(service.build))),
      hasServer:
        body.hasServer ??
        (info.workloadType
          ? info.workloadType === "web"
          : info.projectType === "services" || Boolean(info.startCommand)),
      projectType: body.projectType ?? info.projectType,
      publicEndpoints: body.publicEndpoints ?? info.publicEndpoints,
      routingConfig: body.routingConfig ?? info.routing,
      readiness: body.readiness ?? info.readiness,
      monorepoApps: body.monorepoApps ?? info.monorepoApps,
      monorepoWorkspace: body.monorepoWorkspace ?? info.monorepoWorkspace,
      services: info.services,
    });
      return { project, serviceCount: info.services?.length ?? 0 };
    },
    async list(ctx) {
      requireLocalProjects();
      const projects: unknown[] = [];
      for (let page = 1; ; page++) {
        const result = await projectService.listProjects(ctx.organizationId, { page, perPage: 1000, gitProvider: "local",
          canRead: id => authorization.checkPermissionOnResource(ctx, { resourceType: "project", resourceId: id, action: "read" }),
        });
        projects.push(...result.rows);
        if (page * result.perPage >= result.total || !result.rows.length) break;
      }
      return projects;
    },
  };
}
