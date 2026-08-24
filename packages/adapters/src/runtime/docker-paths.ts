import { access, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

function toPosixPath(value: string): string {
  return value.split(sep).filter(Boolean).join("/");
}

/**
 * Split a caller-supplied path into segments, refusing any that climbs out of
 * the directory it will be resolved against.
 *
 * These values are joined onto a host temp build-context dir, interpolated as
 * a generated Dockerfile `WORKDIR`, and used as the root of the tarball
 * uploaded to a cloud workspace. A surviving `..` escapes all three — which is
 * how `rootDirectory: "../.."` archived arbitrary host directories into the
 * caller's own cloud workspace (GHSA-443m-7g52-94w8).
 *
 * Throwing rather than stripping is deliberate: silently rewriting `../../etc`
 * to the repo root would build and deploy something the caller did not ask for.
 * Segmenting on BOTH separators is also deliberate — splitting on the platform
 * `sep` would let a Windows control plane pass `..\..` through as one opaque
 * segment that never equals "..".
 */
function toSafeSegments(value: string, label: string): string[] {
  const segments = value.split(/[\\/]/).filter((segment) => segment && segment !== ".");

  if (segments.includes("..")) {
    throw new Error(
      `Invalid ${label} ${JSON.stringify(value)}: path segments must not contain "..".`,
    );
  }

  return segments;
}

export function normalizeDockerRelativePath(value?: string | null): string {
  const normalized = value
    ?.trim()
    .replace(/^\.\//, "")
    .replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized === ".") {
    return "";
  }

  return toSafeSegments(normalized, "path").join("/");
}

/**
 * Join a sub-path onto a base directory and PROVE the result stayed inside it.
 *
 * Backstop for the tar-and-upload path, which archives whatever directory it is
 * handed: correctness there must not depend on a normalizer having been called
 * upstream. Absolute input is treated as relative to the base rather than
 * honoured, so it is contained rather than followed.
 */
export function resolveWithinDirectory(baseDir: string, relativePath?: string | null): string {
  const base = resolve(baseDir);
  const target = resolve(base, ...toSafeSegments(relativePath?.trim() ?? "", "path"));
  const escape = relative(base, target);

  // Segment-precise: a plain startsWith("..") would also reject a directory
  // legitimately named "..foo".
  if (escape === ".." || escape.startsWith(`..${sep}`) || isAbsolute(escape)) {
    throw new Error(`Resolved path ${JSON.stringify(target)} escapes ${JSON.stringify(base)}.`);
  }

  return target;
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

  // Must run for relative input too. The `..` check above is reachable only
  // when the value is absolute AND localPath is known, so a plain "../.." used
  // to walk straight through to the callers.
  return toSafeSegments(normalized, "rootDirectory").join("/");
}

function resolveExplicitDockerfileCandidate(
  rootDirectory?: string | null,
  dockerfilePath?: string | null,
): string {
  const normalizedRootDirectory = normalizeDockerRelativePath(rootDirectory);
  const normalizedDockerfilePath = normalizeDockerRelativePath(dockerfilePath);

  if (!normalizedDockerfilePath) {
    return "";
  }

  if (!normalizedRootDirectory) {
    return normalizedDockerfilePath;
  }

  if (normalizedDockerfilePath.startsWith(`${normalizedRootDirectory}/`)) {
    return normalizedDockerfilePath;
  }

  return `${normalizedRootDirectory}/${normalizedDockerfilePath}`;
}

export function resolveDockerfileCandidates(
  rootDirectory?: string | null,
  explicitDockerfilePath?: string | null,
): string[] {
  const normalizedRootDirectory = normalizeDockerRelativePath(rootDirectory);

  return [
    resolveExplicitDockerfileCandidate(rootDirectory, explicitDockerfilePath),
    normalizedRootDirectory ? `${normalizedRootDirectory}/Dockerfile` : "Dockerfile",
    "Dockerfile",
  ].filter(
    (candidate, index, values) => Boolean(candidate) && values.indexOf(candidate) === index,
  );
}

/**
 * Where `docker build` should `cd` / what `-f` should be, given a clone-root
 * context and a Dockerfile path that is also clone-root relative.
 *
 * Repository Dockerfiles under `rootDirectory` (the compose `build.context`,
 * GHA `context: apps/mail`) have COPY paths relative to that directory. Clone-
 * on-server used to `cd` the clone root and pass `-f apps/mail/tinycld/Dockerfile
 * .`, so BuildKit looked for `tinycld/config/entrypoint.sh` at the repo root.
 *
 * Generated `Dockerfile.openship*` files live at the clone root and `COPY .`,
 * so those keep the clone as context.
 */
export function resolveDockerBuildWorkdir(
  contextRoot: string,
  rootDirectory: string | null | undefined,
  dockerfileName: string,
): { workdir: string; dockerfilePath: string } {
  const root = normalizeDockerRootDirectory(rootDirectory);
  const dockerfile = normalizeDockerRelativePath(dockerfileName) || "Dockerfile";
  const base = contextRoot.replace(/\/+$/, "") || contextRoot;

  // `Dockerfile.openship` is a clone-root adapter (COPY apps/<pkg>/…) used
  // until the control plane cds into rootDirectory. Do not cd into the app
  // dir for it — COPY paths would double-prefix.
  const cloneRootAdapter =
    dockerfile === "Dockerfile.openship" || dockerfile.endsWith("/Dockerfile.openship");

  if (root && dockerfile.startsWith(`${root}/`) && !cloneRootAdapter) {
    const relativeDockerfile = dockerfile.slice(root.length + 1) || "Dockerfile";
    return {
      workdir: `${base}/${root}`,
      dockerfilePath: relativeDockerfile,
    };
  }

  return { workdir: base, dockerfilePath: dockerfile };
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
