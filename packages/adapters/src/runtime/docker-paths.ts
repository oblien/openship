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
 * The declared docker build CONTEXT for a config, relative to the source root
 * ("" = the source root itself). ONE reader for `buildContextDirectory` so the
 * local, SSH, clone-on-server and cloud paths cannot disagree about where a
 * build's context begins.
 */
export function dockerBuildContextDirectory(config: {
  buildContextDirectory?: string | null;
}): string {
  return normalizeDockerRelativePath(config.buildContextDirectory);
}

/**
 * Dockerfile candidates INSIDE a narrowed build context, in priority order and
 * relative to that context — what `-f` (and dockerode's `dockerfile`) wants.
 *
 * Compose resolves `dockerfile` against the context, so `build: svc` +
 * `dockerfile: Dockerfile` is the `Dockerfile` sitting in `svc`. Two deliberate
 * differences from {@link resolveDockerfileCandidates}:
 *
 *   - No source-root `Dockerfile` fallback. It lies outside the context, so
 *     falling back to it would build a DIFFERENT image under this service's tag —
 *     which is exactly what a whole-repo context let happen.
 *   - A `dockerfilePath` that already carries the context prefix (`svc/Dockerfile`
 *     next to `build: svc`) is accepted as a second candidate. That spelling is
 *     what people wrote while the context WAS the repo root, and it only ever
 *     wins when the compose-correct path is absent.
 */
export function resolveContextDockerfileCandidates(
  contextDirectory?: string | null,
  explicitDockerfilePath?: string | null,
): string[] {
  const context = normalizeDockerRelativePath(contextDirectory);
  const explicit = normalizeDockerRelativePath(explicitDockerfilePath);
  const candidates: string[] = [];

  if (explicit) {
    candidates.push(explicit);
    if (context && explicit.startsWith(`${context}/`)) {
      candidates.push(explicit.slice(context.length + 1));
    }
  }
  candidates.push("Dockerfile");

  return candidates.filter(
    (candidate, index, values) => Boolean(candidate) && values.indexOf(candidate) === index,
  );
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
