import { access, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

function toPosixPath(value: string): string {
  return value.split(sep).filter(Boolean).join("/");
}

export function normalizeDockerRootDirectory(rootDirectory?: string, localPath?: string): string {
  let normalized = rootDirectory?.trim() ?? "";

  if (!normalized) {
    return "";
  }

  if (localPath && isAbsolute(normalized)) {
    const relativePath = relative(localPath, normalized);
    if (!relativePath || relativePath === ".") {
      return "";
    }

    if (!relativePath.startsWith("..") && !isAbsolute(relativePath)) {
      normalized = relativePath;
    }
  }

  normalized = normalized
    .replace(/^\.\//, "")
    .replace(/^\/+|\/+$/g, "");

  if (!normalized || normalized === ".") {
    return "";
  }

  return toPosixPath(normalized);
}

const ROOT_MANIFESTS = [
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Pipfile",
  "go.mod",
  "Cargo.toml",
  "Gemfile",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "mix.exs",
  "Dockerfile",
];

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  ".venv",
  "__pycache__",
  "build",
  "dist",
  "target",
  "vendor",
]);

type RootCandidate = {
  path: string;
  score: number;
};

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}

async function manifestCount(dir: string): Promise<number> {
  let count = 0;

  for (const file of ROOT_MANIFESTS) {
    if (await pathExists(join(dir, file))) {
      count += 1;
    }
  }

  return count;
}

function pathSegments(path: string): string[] {
  return path.toLowerCase().split("/").filter(Boolean);
}

function scorePathHints(relativePath: string): number {
  const segments = pathSegments(relativePath);
  let score = 0;

  for (const segment of segments) {
    if (["app", "apps", "site", "sites", "web", "www", "service", "services"].includes(segment)) {
      score += 12;
    }
    if (["docs", "example", "examples", "test", "tests", "storybook"].includes(segment)) {
      score -= 18;
    }
  }

  return score;
}

async function scoreCandidate(dir: string, relativePath: string): Promise<number> {
  let score = scorePathHints(relativePath);
  score += await manifestCount(dir) * 20;

  if (relativePath) {
    score += 6;
  }

  return score;
}

async function collectCandidates(
  rootDir: string,
  currentDir: string,
  depth: number,
  candidates: RootCandidate[],
): Promise<void> {
  const relativePath = toPosixPath(relative(rootDir, currentDir));

  if (await manifestCount(currentDir) > 0) {
    candidates.push({
      path: relativePath,
      score: await scoreCandidate(currentDir, relativePath),
    });
  }

  if (depth >= 6) {
    return;
  }

  const entries = await readdir(currentDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) {
      continue;
    }

    await collectCandidates(rootDir, join(currentDir, entry.name), depth + 1, candidates);
  }
}

export async function resolveDockerRootDirectory(
  contextDir: string,
  rootDirectory?: string,
  localPath?: string,
): Promise<string> {
  const hasExplicitRootDirectory = typeof rootDirectory === "string";
  const normalized = normalizeDockerRootDirectory(rootDirectory, localPath);

  // Explicit values like ".", "./", or "/" mean "use the repo root".
  // They normalize to an empty string, but must NOT trigger auto-detection.
  if (hasExplicitRootDirectory) {
    return normalized;
  }

  if (normalized) {
    return normalized;
  }

  const candidates: RootCandidate[] = [];
  await collectCandidates(contextDir, contextDir, 0, candidates);

  if (candidates.length === 0) {
    return "";
  }

  candidates.sort((left, right) => right.score - left.score);
  const bestNonRoot = candidates.find((candidate) => candidate.path);

  if (bestNonRoot && bestNonRoot.score > 0) {
    return bestNonRoot.path;
  }

  return candidates[0]?.path ?? "";
}