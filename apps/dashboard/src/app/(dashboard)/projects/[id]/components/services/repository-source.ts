import type { RepositorySource } from "@/components/github/RepositoryPathBrowser";
import { normalizeProjectRootDirectory } from "@repo/core";

export interface ServiceRepositorySource extends RepositorySource {
  /** Existing Compose contexts are relative to this project directory. */
  projectDirectory: string;
}

export function serviceRepositorySource(project: {
  gitOwner?: string | null;
  gitRepo?: string | null;
  gitBranch?: string | null;
  serverId?: string | null;
  gitProvider?: string | null;
  rootDirectory?: string | null;
  options?: { rootDirectory?: unknown };
}): ServiceRepositorySource | null {
  if (
    !project.gitOwner ||
    !project.gitRepo ||
    project.gitOwner === "local" ||
    (project.gitProvider && project.gitProvider !== "github")
  )
    return null;
  return {
    owner: project.gitOwner,
    repo: project.gitRepo,
    branch: project.gitBranch || undefined,
    serverId: project.serverId ?? undefined,
    projectDirectory:
      project.rootDirectory ??
      (typeof project.options?.rootDirectory === "string" ? project.options.rootDirectory : "."),
  };
}

/** UI paths are repository-relative; the existing engine owns build validation. */
export function repositoryBuildFields(
  source: ServiceRepositorySource,
  context: string,
  dockerfile: string,
): { build: string; dockerfile: string } | "invalidPath" | "outsideContext" {
  const parts = (path: string) =>
    path
      .trim()
      .split("/")
      .filter((part) => part && part !== ".");
  const invalid = (path: string) =>
    !path.trim() ||
    path.trim().startsWith("/") ||
    /^[A-Za-z]:/.test(path.trim()) ||
    /[\\\x00-\x1f\x7f]/.test(path) ||
    path.split("/").includes("..");
  const directory = normalizeProjectRootDirectory(source.projectDirectory) || ".";
  if (invalid(context) || invalid(dockerfile) || invalid(directory)) return "invalidPath";
  const target = parts(context);
  const file = parts(dockerfile);
  if (file.length <= target.length || target.some((part, i) => file[i] !== part))
    return "outsideContext";
  const base = parts(directory);
  let shared = 0;
  while (shared < base.length && shared < target.length && base[shared] === target[shared])
    shared++;
  return {
    build: [...base.slice(shared).map(() => ".."), ...target.slice(shared)].join("/") || ".",
    dockerfile: file.slice(target.length).join("/"),
  };
}
