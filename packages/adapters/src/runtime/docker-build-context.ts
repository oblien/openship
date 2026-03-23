import { execFile as cpExecFile } from "node:child_process";
import { access, cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";

import ignore from "ignore";

import { STACKS, TRANSFER_EXCLUDES, type StackDefinition, type StackId } from "@repo/core";

import type { BuildConfig } from "../types";

import { injectGitToken } from "./build-pipeline";
import { generateDockerfile } from "./docker-build-plan";
import { resolveDockerRootDirectory } from "./docker-paths";

const execFileAsync = promisify(cpExecFile);

const GENERATED_DOCKERFILE_NAME = "Dockerfile.openship";

type IgnoreMatcher = ReturnType<typeof ignore>;

function getDockerContextExcludes(config: BuildConfig): Set<string> {
  const stack = STACKS[config.stack as StackId] as StackDefinition | undefined;
  return new Set([
    ...TRANSFER_EXCLUDES,
    ...(stack?.cacheDirs ?? []),
  ]);
}

function shouldCopyPath(root: string, candidate: string, excludes: Set<string>): boolean {
  const rel = relative(root, candidate);
  if (!rel || rel === ".") return true;
  const parts = rel.split(sep).filter(Boolean);
  return !parts.some((part) => excludes.has(part));
}

function normalizeRelativePath(value?: string): string {
  const normalized = value?.trim().replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized === ".") {
    return "";
  }

  return normalized;
}

function toPosixPath(value: string): string {
  return value.split(sep).filter(Boolean).join("/");
}

function shouldExcludeRelativePath(
  relativePath: string,
  excludes: Set<string>,
  dockerignoreMatcher?: IgnoreMatcher,
): boolean {
  const normalized = toPosixPath(relativePath);
  const parts = normalized.split("/").filter(Boolean);

  if (parts.some((part) => excludes.has(part))) {
    return true;
  }

  return dockerignoreMatcher?.ignores(normalized) ?? false;
}

async function loadDockerignoreMatcher(rootPath: string): Promise<IgnoreMatcher | undefined> {
  try {
    const content = await readFile(join(rootPath, ".dockerignore"), "utf-8");
    return ignore().add(content);
  } catch {
    return undefined;
  }
}

async function pruneContextDirectory(
  rootPath: string,
  currentPath: string,
  excludes: Set<string>,
  dockerignoreMatcher?: IgnoreMatcher,
): Promise<void> {
  const entries = await readdir(currentPath, { withFileTypes: true });

  await Promise.all(entries.map(async (entry) => {
    const absolutePath = join(currentPath, entry.name);
    const relativePath = relative(rootPath, absolutePath);

    if (shouldExcludeRelativePath(relativePath, excludes, dockerignoreMatcher)) {
      await rm(absolutePath, { recursive: true, force: true });
      return;
    }

    if (entry.isDirectory()) {
      await pruneContextDirectory(rootPath, absolutePath, excludes, dockerignoreMatcher);
    }
  }));
}

async function resolveDockerfileName(contextDir: string, rootDirectory?: string): Promise<string | null> {
  const normalizedRootDirectory = normalizeRelativePath(rootDirectory);
  const candidates = [
    normalizedRootDirectory ? `${normalizedRootDirectory}/Dockerfile` : "Dockerfile",
    "Dockerfile",
  ].filter((candidate, index, values) => values.indexOf(candidate) === index);

  for (const candidate of candidates) {
    const candidatePath = join(contextDir, ...candidate.split("/"));
    const exists = await access(candidatePath).then(() => true).catch(() => false);
    if (exists) {
      return candidate;
    }
  }

  return null;
}

async function copyLocalSource(
  sourcePath: string,
  targetPath: string,
  excludes: Set<string>,
  dockerignoreMatcher?: IgnoreMatcher,
): Promise<void> {
  await cp(sourcePath, targetPath, {
    recursive: true,
    filter: (candidate) => {
      if (!shouldCopyPath(sourcePath, candidate, excludes)) {
        return false;
      }

      const rel = relative(sourcePath, candidate);
      if (!rel || rel === ".") {
        return true;
      }

      return !shouldExcludeRelativePath(rel, excludes, dockerignoreMatcher);
    },
    force: true,
  });
}

async function cloneGitSource(config: BuildConfig, targetPath: string): Promise<void> {
  const cloneUrl = injectGitToken(config.repoUrl, config.gitToken);
  await execFileAsync("git", [
    "clone",
    "--depth",
    config.commitSha ? "50" : "1",
    "--branch",
    config.branch,
    cloneUrl,
    targetPath,
  ]);

  if (config.commitSha) {
    await execFileAsync("git", ["-C", targetPath, "checkout", config.commitSha]);
  }

  await rm(join(targetPath, ".git"), { recursive: true, force: true });
}

export interface DockerBuildContext {
  contextDir: string;
  contextEntries: string[];
  dockerfileName: string;
  rootDirectory: string;
  usesRepositoryDockerfile: boolean;
  cleanup(): Promise<void>;
}

export async function createDockerBuildContext(config: BuildConfig): Promise<DockerBuildContext> {
  const contextDir = await mkdtemp(join(tmpdir(), "openship-docker-context-"));
  const excludes = getDockerContextExcludes(config);

  try {
    if (config.localPath) {
      const dockerignoreMatcher = await loadDockerignoreMatcher(config.localPath);
      await copyLocalSource(config.localPath, contextDir, excludes, dockerignoreMatcher);
    } else {
      await cloneGitSource(config, contextDir);
      const dockerignoreMatcher = await loadDockerignoreMatcher(contextDir);
      await pruneContextDirectory(contextDir, contextDir, excludes, dockerignoreMatcher);
    }

    const resolvedRootDirectory = await resolveDockerRootDirectory(
      contextDir,
      config.rootDirectory,
      config.localPath,
    );

    const repositoryDockerfileName = await resolveDockerfileName(contextDir, resolvedRootDirectory);
    const hasRepositoryDockerfile = repositoryDockerfileName !== null;

    if (!hasRepositoryDockerfile) {
      await writeFile(
        join(contextDir, GENERATED_DOCKERFILE_NAME),
        generateDockerfile({
          ...config,
          rootDirectory: resolvedRootDirectory,
        }),
        "utf-8",
      );
    }

    const contextEntries = await readdir(contextDir);

    return {
      contextDir,
      contextEntries,
      dockerfileName: repositoryDockerfileName ?? GENERATED_DOCKERFILE_NAME,
      rootDirectory: resolvedRootDirectory,
      usesRepositoryDockerfile: hasRepositoryDockerfile,
      cleanup: async () => {
        await rm(contextDir, { recursive: true, force: true }).catch(() => {});
      },
    };
  } catch (error) {
    await rm(contextDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}