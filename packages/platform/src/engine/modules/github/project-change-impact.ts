/** Read-only path policies and workspace dependency analysis.
 * Unknown metadata always deploys. No repository scripts or Turbo binaries run
 * in the control plane. All reads use the existing authorized GitHub boundary. */
import { diagnostics } from "@repo/core/diagnostics";
import {
  matchesAny,
  normalizeRepoPath,
  normalizeRepoPattern,
  normalizeProjectRootDirectory,
  parseWorkspaceManifest,
  parseOpenshipConfigJson,
} from "@repo/core";
import type { Project } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import { requestMemo } from "../../lib/request-store";
import { getFileContent, listRepositoryTree } from "./github.service";
import { classifyChangedFiles, serviceMatchesChanges } from "./webhook-changed-files";

export interface ProjectChangeImpact {
  affected: boolean;
  reason: string;
}
type Manifest = Record<string, unknown>;
interface Workspace {
  root: string;
  name: string;
  dependencies: string[];
}
const MAX_WORKSPACES = 50;
const MAX_MANIFEST_BYTES = 256 * 1024;

function jsonObject(text: string): Manifest {
  let result: unknown;
  try {
    result = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("Workspace configuration is not valid JSON");
  }
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new Error("Invalid workspace manifest");
  return result as Manifest;
}
function patterns(values: unknown): string[] {
  if (!Array.isArray(values) || values.length > 100)
    throw new Error("Unsupported workspace patterns");
  return values.map((value) => {
    if (
      typeof value !== "string" ||
      /[?\[\]{}]/.test(value) ||
      !normalizeRepoPattern(value.startsWith("!") ? value.slice(1) : value)
    )
      throw new Error("Unsupported workspace pattern");
    return value;
  });
}
function matchesPatterns(path: string, rules: string[]): boolean {
  return (
    matchesAny(
      path,
      rules.filter((rule) => !rule.startsWith("!")),
    ) &&
    !matchesAny(
      path,
      rules.filter((rule) => rule.startsWith("!")).map((rule) => rule.slice(1)),
    )
  );
}
function dependencyNames(manifest: Manifest): string[] {
  const names = new Set<string>();
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const values = manifest[field];
    if (values === undefined) continue;
    if (!values || typeof values !== "object" || Array.isArray(values))
      throw new Error("Invalid dependency map");
    for (const [name, version] of Object.entries(values)) {
      if (typeof version !== "string") throw new Error("Invalid dependency version");
      // Local file/link aliases can point outside the package graph. They need
      // explicit path rules until we can resolve them without guessing.
      if (
        /^(?:file:|link:|portal:)/.test(version) ||
        version.startsWith("workspace:.") ||
        version.startsWith("workspace:/") ||
        (version.startsWith("workspace:") && version.slice(10).includes("@"))
      )
        throw new Error("Workspace uses path-linked dependencies");
      names.add(name);
    }
  }
  return [...names];
}

/** A fresh immutable commit and a complete file list are prerequisites for
 * skipping. Callers already handle forced deploys and incomplete push diffs. */
export async function resolveProjectChangeImpact(
  ctx: ExecutionContext,
  project: Pick<Project, "id" | "rootDirectory" | "gitOwner" | "gitRepo" | "monorepoSharedPaths"> &
    Partial<Pick<Project, "framework" | "buildKind">>,
  files: readonly string[],
  commitSha?: string | null,
): Promise<ProjectChangeImpact> {
  const root = normalizeProjectRootDirectory(project.rootDirectory ?? undefined);
  if (!files.length || files.some((file) => !file || normalizeRepoPath(file) !== file))
    return { affected: true, reason: "unknown-changes" };
  const global = classifyChangedFiles(files, {
    isMonorepo: true,
    monorepoSharedPaths: project.monorepoSharedPaths,
  });
  if (global.forceAll) return { affected: true, reason: global.reason! };
  if (files.includes(`${root}/openship.json`)) return { affected: true, reason: "project-config" };
  if (!project.gitOwner || !project.gitRepo || !commitSha || !/^[a-f\d]{40}$/i.test(commitSha))
    return { affected: true, reason: "unknown-revision" };

  const signal = AbortSignal.timeout(10_000);
  const key = JSON.stringify([
    ctx.organizationId,
    ctx.userId,
    ctx.tokenScope?.tokenId,
    project.gitOwner,
    project.gitRepo,
    commitSha,
  ]);
  const read = (path: string) =>
    requestMemo(`impact:file:${key}:${path}`, async () => {
      signal.throwIfAborted();
      try {
        const file = await getFileContent(ctx, project.gitOwner!, project.gitRepo!, path, {
          branch: commitSha,
          signal,
        });
        if (file.size > MAX_MANIFEST_BYTES || file.content.length > MAX_MANIFEST_BYTES)
          throw new Error("Workspace manifest exceeds analysis limit");
        return file.content;
      } catch (error) {
        if (error && typeof error === "object" && "status" in error && error.status === 404)
          return null;
        throw error;
      }
    });
  try {
    // The selected app's policy takes precedence over a repository-wide policy.
    const appConfig = root ? await read(`${root}/openship.json`) : null;
    const configText = appConfig ?? (await read("openship.json"));
    let policy;
    if (configText !== null) {
      const parsed = parseOpenshipConfigJson(configText);
      if (!parsed.config || parsed.errors.length) throw new Error("Invalid Openship path policy");
      policy = parsed.config.autoDeployPaths;
    }
    const remaining = policy?.exclude?.length
      ? files.filter((file) => !matchesAny(file, policy.exclude!))
      : [...files];
    if (!remaining.length) return { affected: false, reason: "explicitly-excluded" };
    if (policy?.include) {
      const included = remaining.some((file) => matchesAny(file, policy.include!));
      return {
        affected: included,
        reason: included ? "explicitly-included" : "outside-explicit-includes",
      };
    }
    if (serviceMatchesChanges(root, remaining)) return { affected: true, reason: "project-files" };

    if (project.framework === "docker" || project.buildKind === "dockerfile")
      return { affected: true, reason: "custom-build-context" };

    const catalog = await requestMemo(`impact:workspace:${key}`, async () => {
      const tree = await listRepositoryTree(ctx, project.gitOwner!, project.gitRepo!, {
        branch: commitSha,
        requireComplete: true,
        signal,
      });
      if (tree.length > 50_000) throw new Error("Repository exceeds workspace analysis limit");
      const paths = new Set(
        tree.filter((entry) => entry.type === "file").map((entry) => entry.path),
      );
      const rootText = await read("package.json");
      if (rootText === null) throw new Error("No workspace manifest");
      const rootManifest = jsonObject(rootText);
      const pnpm = paths.has("pnpm-workspace.yaml") ? await read("pnpm-workspace.yaml") : null;
      const entries = parseWorkspaceManifest(
        pnpm !== null ? "pnpm-workspace.yaml" : "package.json",
        pnpm ?? rootText,
      );
      const rules = patterns(entries[0]?.patterns ?? []);
      if (!rules.length) throw new Error("No declared JavaScript workspaces");
      const manifestPaths = [...paths].filter(
        (path) => path.endsWith("/package.json") && matchesPatterns(path.slice(0, -13), rules),
      );
      if (!manifestPaths.length || manifestPaths.length > MAX_WORKSPACES)
        throw new Error("Workspace catalog exceeds analysis limit");
      const packages: Workspace[] = [];
      const requiredNames = new Set<string>();
      const requireLocalNames = (manifest: Manifest) => {
        for (const field of [
          "dependencies",
          "devDependencies",
          "optionalDependencies",
          "peerDependencies",
        ])
          for (const [name, version] of Object.entries((manifest[field] ?? {}) as Manifest))
            if (typeof version === "string" && version.startsWith("workspace:"))
              requiredNames.add(name);
      };
      requireLocalNames(rootManifest);
      // Keep GitHub fan-out bounded, sharing reads within the delivery request.
      for (let offset = 0; offset < manifestPaths.length; offset += 4) {
        await Promise.all(
          manifestPaths.slice(offset, offset + 4).map(async (path) => {
            const text = await read(path);
            if (text === null) throw new Error("Workspace manifest disappeared");
            const manifest = jsonObject(text);
            if (typeof manifest.name !== "string" || !manifest.name)
              throw new Error("Workspace has no unique package name");
            requireLocalNames(manifest);
            packages.push({
              root: path.slice(0, -13),
              name: manifest.name,
              dependencies: dependencyNames(manifest),
            });
          }),
        );
      }
      if (new Set(packages.map((pkg) => pkg.name)).size !== packages.length)
        throw new Error("Duplicate workspace package names");
      if ([...requiredNames].some((name) => !packages.some((pkg) => pkg.name === name)))
        throw new Error("Unresolved workspace dependency");
      const globalPaths: string[] = [];
      const taskDependencies = new Set<string>();
      // Root and package Turbo configs can add dependencies beyond package.json.
      for (const path of [...paths].filter(
        (path) =>
          path === "turbo.json" ||
          path === "turbo.jsonc" ||
          packages.some(
            (pkg) => path === `${pkg.root}/turbo.json` || path === `${pkg.root}/turbo.jsonc`,
          ),
      )) {
        const text = await read(path);
        if (text === null) throw new Error("Turbo configuration disappeared");
        const turbo = jsonObject(text); // JSONC/other unsupported forms safely rebuild.
        if (turbo.extends && JSON.stringify(turbo.extends) !== '["//"]')
          throw new Error("Turbo extends external configuration");
        if (turbo.globalDependencies !== undefined)
          globalPaths.push(...patterns(turbo.globalDependencies));
        const tasks = turbo.tasks ?? turbo.pipeline ?? {};
        if (!tasks || typeof tasks !== "object" || Array.isArray(tasks))
          throw new Error("Invalid Turbo task map");
        for (const task of Object.values(tasks as Manifest)) {
          if (!task || typeof task !== "object") throw new Error("Invalid Turbo task");
          const definition = task as Manifest;
          if (
            (definition.dependsOn !== undefined && !Array.isArray(definition.dependsOn)) ||
            (definition.inputs !== undefined && !Array.isArray(definition.inputs))
          )
            throw new Error("Invalid Turbo task dependencies or inputs");
          for (const dependency of (definition.dependsOn ?? []) as unknown[]) {
            if (typeof dependency !== "string") throw new Error("Invalid Turbo dependency");
            if (dependency.includes("#")) taskDependencies.add(dependency.split("#")[0]!);
          }
          for (const input of (definition.inputs ?? []) as unknown[]) {
            if (typeof input !== "string") throw new Error("Invalid Turbo input");
            if (input.split("/").includes(".."))
              throw new Error("Turbo inputs cross a package boundary");
            if (input === "$TURBO_ROOT$") globalPaths.push("**");
            if (input.startsWith("$TURBO_ROOT$/")) globalPaths.push(...patterns([input.slice(13)]));
          }
        }
      }
      if ([...taskDependencies].some((name) => !packages.some((pkg) => pkg.name === name)))
        throw new Error("Unresolved Turbo task dependency");
      return {
        packages,
        globalPaths,
        globalDependencies: [...dependencyNames(rootManifest), ...taskDependencies],
      };
    });
    const byName = new Map(catalog.packages.map((pkg) => [pkg.name, pkg]));
    const selected = catalog.packages.find((pkg) => pkg.root === root);
    if (!selected) throw new Error("Selected project is not a declared workspace");
    if (remaining.some((file) => matchesPatterns(file, catalog.globalPaths)))
      return { affected: true, reason: "turbo-global-input" };
    const affectedRoots = new Set<string>();
    const visit = (name: string) => {
      const pkg = byName.get(name);
      if (!pkg || affectedRoots.has(pkg.root)) return;
      affectedRoots.add(pkg.root);
      for (const dependency of pkg.dependencies) visit(dependency);
    };
    visit(selected.name);
    for (const dependency of catalog.globalDependencies) visit(dependency);
    for (const file of remaining) {
      const knownWorkspace = catalog.packages.some((pkg) =>
        serviceMatchesChanges(pkg.root, [file]),
      );
      if (!knownWorkspace) return { affected: true, reason: "shared-or-unknown-file" };
      // A parent package can consume files in a nested workspace through its
      // own build context. A more specific workspace must not hide that input.
      if ([...affectedRoots].some((root) => serviceMatchesChanges(root, [file])))
        return { affected: true, reason: "workspace-dependency" };
    }
    return { affected: false, reason: "unrelated-workspaces" };
  } catch (error) {
    diagnostics.warn(
      "github/project-change-impact",
      "Could not prove this change is unrelated; deploying the project.",
      error,
      { projectId: project.id },
    );
    return { affected: true, reason: "analysis-unavailable" };
  }
}
