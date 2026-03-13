/**
 * Prepare service — resolves project info from a source (GitHub or local path).
 *
 * Pure introspection: reads files, detects stack, returns a unified shape.
 * No database writes, no deployment logic.
 */

import * as githubService from "../github/github.service";
import { detectStack, type RepoFile, type StackResult } from "../../lib/stack-detector";
import { parseComposeFile, type ComposeService } from "../../lib/compose-parser";
import type { ProjectType } from "@repo/core";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────────────

export type Source =
  | { source: "github"; owner: string; repo: string; userId: string }
  | { source: "local"; path: string };

export interface ProjectInfo {
  repository: {
    name: string;
    full_name: string;
    owner: { login: string };
    private: boolean;
    default_branch: string;
    clone_url?: string;
    html_url?: string;
    branches?: { name: string }[];
  };
  stack: StackResult["stack"];
  projectType: ProjectType;
  category: string;
  packageManager: string;
  buildCommand: string;
  installCommand: string;
  startCommand: string;
  buildImage: string;
  outputDirectory: string;
  port: number;
  services?: ComposeService[];
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Resolve project info from either a GitHub repo or a local filesystem path.
 * Both paths converge on detectStack and return the same ProjectInfo shape.
 */
export async function resolveProjectInfo(input: Source): Promise<ProjectInfo> {
  if (input.source === "github") {
    return resolveFromGitHub(input.userId, input.owner, input.repo);
  }
  return resolveFromLocal(input.path);
}

// ─── GitHub ──────────────────────────────────────────────────────────────────

async function resolveFromGitHub(userId: string, owner: string, repo: string): Promise<ProjectInfo> {
  const repository = await githubService.getRepository(userId, owner, repo, {
    withBranches: true,
  });

  let files: RepoFile[] = [];
  let packageJson: Record<string, unknown> | undefined;

  try {
    const contents = await githubService.listFiles(userId, owner, repo, {
      branch: repository.default_branch,
    });
    if (Array.isArray(contents)) {
      files = contents.map((f: any) => ({
        name: f.name,
        type: f.type === "dir" ? "dir" : "file",
      }));
    }
  } catch {
    // Repo might be empty
  }

  try {
    const pkgFile = await githubService.getFileContent(userId, owner, repo, "package.json", {
      branch: repository.default_branch,
      json: true,
    });
    if (pkgFile?.content) {
      packageJson = typeof pkgFile.content === "string"
        ? JSON.parse(pkgFile.content)
        : pkgFile.content;
    }
  } catch {
    // No package.json
  }

  // Try reading compose file
  let composeContent: string | undefined;
  const composeNames = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];
  for (const name of composeNames) {
    if (files.some((f) => f.name.toLowerCase() === name)) {
      try {
        const composeFile = await githubService.getFileContent(userId, owner, repo, name, {
          branch: repository.default_branch,
        });
        if (composeFile?.content) {
          composeContent = composeFile.content;
          break;
        }
      } catch {
        // Not found, try next
      }
    }
  }

  return toProjectInfo(repository, files, packageJson, composeContent);
}

// ─── Local filesystem ────────────────────────────────────────────────────────

async function resolveFromLocal(dirPath: string): Promise<ProjectInfo> {
  const st = await stat(dirPath);
  if (!st.isDirectory()) {
    throw new Error("Path is not a directory");
  }

  const entries = await readdir(dirPath, { withFileTypes: true });
  const files: RepoFile[] = entries.map((e) => ({
    name: e.name,
    type: e.isDirectory() ? "dir" : "file",
  }));

  let packageJson: Record<string, unknown> | undefined;
  try {
    const raw = await readFile(`${dirPath}/package.json`, "utf-8");
    packageJson = JSON.parse(raw);
  } catch {
    // No package.json or invalid — that's fine
  }

  // Try reading compose file
  let composeContent: string | undefined;
  const composeNames = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];
  for (const name of composeNames) {
    try {
      composeContent = await readFile(`${dirPath}/${name}`, "utf-8");
      break;
    } catch {
      // Try next
    }
  }

  const dirName = (packageJson?.name as string) ?? basename(dirPath);

  const repoShape = {
    name: dirName,
    full_name: dirPath,
    owner: "local",
    private: true,
    default_branch: "main",
  } as const;

  return toProjectInfo(repoShape, files, packageJson, composeContent);
}

// ─── Shared mapper ───────────────────────────────────────────────────────────

function toProjectInfo(
  repo: {
    name: string;
    full_name: string;
    owner: string;
    private: boolean;
    default_branch: string;
    clone_url?: string;
    html_url?: string;
    branches?: { name: string }[];
  },
  files: RepoFile[],
  packageJson?: Record<string, unknown>,
  composeContent?: string,
): ProjectInfo {
  const stack = detectStack(files, packageJson);

  // Parse compose file if detected as a services project
  let services: ComposeService[] | undefined;
  if (composeContent && stack.projectType === "services") {
    try {
      const parsed = parseComposeFile(composeContent);
      services = parsed.services;
    } catch {
      // Invalid YAML — continue without services
    }
  }

  return {
    repository: {
      name: repo.name,
      full_name: repo.full_name,
      owner: { login: repo.owner },
      private: repo.private,
      default_branch: repo.default_branch,
      clone_url: repo.clone_url,
      html_url: repo.html_url,
      branches: repo.branches,
    },
    stack: stack.stack,
    projectType: stack.projectType,
    category: stack.category,
    packageManager: stack.packageManager,
    buildCommand: stack.buildCommand,
    installCommand: stack.installCommand,
    startCommand: stack.startCommand,
    buildImage: stack.buildImage,
    outputDirectory: stack.outputDirectory,
    port: stack.port,
    ...(services && { services }),
  };
}
