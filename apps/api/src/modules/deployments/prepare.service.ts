/**
 * Prepare service — resolves project info from a source (GitHub or local path).
 *
 * Pure introspection: reads files, detects stack, returns a unified shape.
 * No database writes, no deployment logic.
 */

import * as githubService from "../github/github.service";
import { detectStack, MANIFEST_FILES, type RepoFile, type StackResult } from "../../lib/stack-detector";
import { parseComposeFile, type ComposeService } from "../../lib/compose-parser";
import type { ProjectType } from "@repo/core";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { env } from "../../config";

// ─── Types ───────────────────────────────────────────────────────────────────

export type Source =
  | { source: "github"; owner: string; repo: string; userId: string; branch?: string }
  | { source: "local"; path: string };

export interface ProjectInfo {
  repository: {
    name: string;
    full_name: string;
    owner: { login: string };
    private: boolean;
    default_branch: string;
    selected_branch?: string;
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
  productionPaths: string[];
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
    return resolveFromGitHub(input.userId, input.owner, input.repo, input.branch);
  }

  // Local filesystem access — blocked in cloud mode
  if (env.CLOUD_MODE) {
    throw new Error("Local project resolution is not available in cloud mode");
  }

  return resolveFromLocal(input.path);
}

// ─── GitHub ──────────────────────────────────────────────────────────────────

async function resolveFromGitHub(
  userId: string,
  owner: string,
  repo: string,
  branch?: string,
): Promise<ProjectInfo> {
  const repository = await githubService.getRepository(userId, owner, repo, {
    withBranches: true,
  });
  const requestedBranch = branch?.trim();
  const selectedBranch = requestedBranch || repository.default_branch;

  if (requestedBranch) {
    const head = await githubService.getLatestCommit(userId, owner, repo, selectedBranch);
    if (!head) {
      throw new Error(`Branch "${selectedBranch}" was not found for ${owner}/${repo}`);
    }
  }

  let files: RepoFile[] = [];
  let packageJson: Record<string, unknown> | undefined;

  try {
    const contents = await githubService.listFiles(userId, owner, repo, {
      branch: selectedBranch,
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
      branch: selectedBranch,
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
          branch: selectedBranch,
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

  // Read manifest files for deep stack detection
  const manifests: Record<string, string> = {};
  const manifestReads = MANIFEST_FILES
    .filter((name) => files.some((f) => f.name.toLowerCase() === name.toLowerCase()))
    .map(async (name) => {
      try {
        const file = await githubService.getFileContent(userId, owner, repo, name, {
          branch: selectedBranch,
        });
        if (file?.content) manifests[name] = file.content;
      } catch { /* skip */ }
    });
  await Promise.all(manifestReads);

  return toProjectInfo(repository, files, packageJson, composeContent, manifests, selectedBranch);
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

  // Read manifest files for deep stack detection
  const manifests: Record<string, string> = {};
  await Promise.all(
    MANIFEST_FILES.map(async (name) => {
      try {
        manifests[name] = await readFile(`${dirPath}/${name}`, "utf-8");
      } catch { /* skip */ }
    }),
  );

  const dirName = (packageJson?.name as string) ?? basename(dirPath);

  const repoShape = {
    name: dirName,
    full_name: dirPath,
    owner: "local",
    private: true,
    default_branch: "main",
  } as const;

  return toProjectInfo(repoShape, files, packageJson, composeContent, manifests, repoShape.default_branch);
}

// ─── Shared mapper ───────────────────────────────────────────────────────────

function toProjectInfo(
  repo: {
    name: string;
    full_name: string;
    owner: string;
    private: boolean;
    default_branch: string;
    selected_branch?: string;
    clone_url?: string;
    html_url?: string;
    branches?: { name: string }[];
  },
  files: RepoFile[],
  packageJson?: Record<string, unknown>,
  composeContent?: string,
  fileContents?: Record<string, string>,
  selectedBranch?: string,
): ProjectInfo {
  const stack = detectStack(files, packageJson, fileContents);

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
      selected_branch: selectedBranch || repo.default_branch,
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
    productionPaths: stack.productionPaths,
    port: stack.port,
    ...(services && { services }),
  };
}
