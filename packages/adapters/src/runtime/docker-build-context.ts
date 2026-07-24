import { spawn } from "node:child_process";
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import ignore from "ignore";

import type { BuildConfig, LogCallback } from "../types";

import { getTarCreateEnv, prepareSourceTarArgs } from "../archive";
import { injectGitToken, toGitHubSshUrl } from "./build-pipeline";
import { generateDockerfile } from "./docker-build-plan";
import { resolveDockerfileCandidates, resolveDockerRootDirectory } from "./docker-paths";

/**
 * IDLE (no-progress) timeout, not a global wall-clock cap: the timer resets on
 * every chunk of git output. A slow-but-progressing clone (large repo, slow
 * link) is never killed — only a genuinely stalled one (DNS hang, dead proxy,
 * network partition → no bytes for the whole window) fails with a clear error
 * instead of pinning a build slot. Git `--progress` streams continuously, so
 * "no output for 5 min" reliably means stalled.
 */
const GIT_CLONE_IDLE_TIMEOUT_MS = 5 * 60_000;
const GIT_CHECKOUT_IDLE_TIMEOUT_MS = 60_000;

/**
 * Run a git subcommand with stderr streamed into the build log and a
 * hard timeout. WHY each env / flag matters:
 *   - GIT_TERMINAL_PROMPT=0 — never prompt for credentials; fail fast.
 *   - GIT_ASKPASS=/bin/echo — backstop for git builds that still try
 *     the askpass path; echo returns empty so git errors out instead
 *     of hanging on a non-existent tty.
 *   - --progress (caller-supplied) — git silences progress when stdout
 *     isn't a tty; we force it so the build-log stream stays alive
 *     during long clones (visible movement, not an idle "Cloning…").
 *   - spawn (not exec) — argv array avoids shell interpolation of the
 *     repo URL / branch; we don't have a shell-injection vector but
 *     also no need for one.
 */
function spawnGit(
  args: string[],
  opts: { timeoutMs: number; onLog?: LogCallback; env?: Record<string, string> },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/bin/echo",
        ...opts.env,
      },
    });

    let stderr = "";
    const emit = opts.onLog;
    const flushLine = (line: string) => {
      const trimmed = line.trimEnd();
      if (!trimmed) return;
      if (emit) {
        emit({ timestamp: new Date().toISOString(), message: trimmed, level: "info" });
      }
    };

    // Idle timeout, not a global cap: (re)armed on every chunk of git output so
    // a slow-but-progressing clone survives, and only a stalled one (no bytes
    // for the whole window) is killed. Git `--progress` streams continuously.
    let idleTimer: ReturnType<typeof setTimeout>;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(
          new Error(
            `git ${args.find((a) => !a.startsWith("-")) ?? "command"} stalled — no progress for ${Math.round(
              opts.timeoutMs / 1000,
            )}s`,
          ),
        );
      }, opts.timeoutMs);
    };

    child.stdout?.on("data", (buf: Buffer) => {
      armIdle();
      for (const ln of buf.toString().split(/\r?\n/)) flushLine(ln);
    });
    child.stderr?.on("data", (buf: Buffer) => {
      armIdle();
      const text = buf.toString();
      stderr += text;
      // Git emits progress on stderr — stream it the same way as stdout
      // so the user sees activity, then surface the tail on failure.
      for (const ln of text.split(/\r?\n/)) flushLine(ln);
    });

    armIdle(); // start the clock; every stdout/stderr chunk resets it

    child.on("error", (err) => {
      clearTimeout(idleTimer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(idleTimer);
      if (code === 0) resolve();
      else reject(new Error(`git exited with code ${code}: ${stderr.trim().slice(-500) || "no stderr"}`));
    });
  });
}

const GENERATED_DOCKERFILE_NAME = "Dockerfile.openship";

type IgnoreMatcher = ReturnType<typeof ignore>;

function toPosixPath(value: string): string {
  return value.split(sep).filter(Boolean).join("/");
}

/**
 * `.dockerignore` matcher for the build context. `.gitignore` is deliberately
 * NOT read here — the base tree is already git-truth (local: `git ls-files`;
 * clone: a clean checkout), so gitignored output was never included. We only
 * layer the docker-specific `.dockerignore` on top (dockerode tars the context
 * as-is and does not honour it itself). Returns undefined when absent.
 */
async function loadDockerignoreMatcher(rootPath: string): Promise<IgnoreMatcher | undefined> {
  try {
    return ignore().add(await readFile(join(rootPath, ".dockerignore"), "utf-8"));
  } catch {
    return undefined; // no .dockerignore
  }
}

/** Remove everything matching `.dockerignore` from an already-materialized
 *  context tree. No-op when the repo has no `.dockerignore`. */
async function applyDockerignore(contextDir: string): Promise<void> {
  const matcher = await loadDockerignoreMatcher(contextDir);
  if (!matcher) return;

  const prune = async (currentPath: string): Promise<void> => {
    const entries = await readdir(currentPath, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const absolutePath = join(currentPath, entry.name);
        const relativePath = relative(contextDir, absolutePath);
        if (matcher.ignores(toPosixPath(relativePath))) {
          await rm(absolutePath, { recursive: true, force: true });
          return;
        }
        if (entry.isDirectory()) await prune(absolutePath);
      }),
    );
  };
  await prune(contextDir);
}

/**
 * Materialize a local source dir into the build context as EXACTLY what git
 * ships (tracked + untracked-not-ignored), via the shared `prepareSourceTarArgs`
 * resolver — the same single source of truth the SSH transfer paths use — piped
 * straight into an extract. No name-list / gitignore-pattern guessing that could
 * drop tracked source (e.g. a Next.js `app/.../build` route).
 */
async function materializeLocalSource(sourcePath: string, targetPath: string): Promise<void> {
  const { args, cleanup } = await prepareSourceTarArgs(sourcePath);
  try {
    await new Promise<void>((resolve, reject) => {
      const create = spawn("tar", args, { env: getTarCreateEnv() });
      const extract = spawn("tar", ["-xzf", "-", "-C", targetPath]);
      let err = "";
      create.stderr.on("data", (d) => (err += d.toString()));
      extract.stderr.on("data", (d) => (err += d.toString()));
      create.on("error", reject);
      extract.on("error", reject);
      create.stdout.pipe(extract.stdin);
      extract.on("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`context materialize failed (tar ${code}): ${err.trim().slice(-500)}`)),
      );
    });
  } finally {
    await cleanup();
  }
}

async function resolveDockerfileName(
  contextDir: string,
  rootDirectory?: string,
  explicitDockerfilePath?: string,
): Promise<string | null> {
  const candidates = resolveDockerfileCandidates(rootDirectory, explicitDockerfilePath);

  for (const candidate of candidates) {
    const candidatePath = join(contextDir, ...candidate.split("/"));
    const exists = await access(candidatePath)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      return candidate;
    }
  }

  return null;
}

async function cloneGitSource(
  config: BuildConfig,
  targetPath: string,
  onLog?: LogCallback,
): Promise<void> {
  // SSH mode (per-server key / deploy key): clone over git@github.com with a
  // 0600 key + pinned known_hosts in a local temp dir (removed in finally).
  // Normally SSH clones run ON the server; this is the orchestrator fallback.
  let cloneUrl: string;
  let gitEnv: Record<string, string> | undefined;
  let sshDir: string | null = null;
  if (config.gitSsh) {
    sshDir = await mkdtemp(join(tmpdir(), "opsh-ghkey-"));
    const keyFile = join(sshDir, "id");
    const knownHostsFile = join(sshDir, "known_hosts");
    await writeFile(keyFile, config.gitSsh.privateKey, { mode: 0o600 });
    await writeFile(knownHostsFile, config.gitSsh.knownHosts, { mode: 0o600 });
    gitEnv = {
      GIT_SSH_COMMAND: `ssh -i ${keyFile} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${knownHostsFile}`,
    };
    cloneUrl = toGitHubSshUrl(config.repoUrl);
  } else {
    cloneUrl = injectGitToken(config.repoUrl, config.gitToken, config.gitTokenUsername);
  }

  try {
    await spawnGit(
      [
        "-c",
        "credential.helper=",
        "clone",
        "--progress",
        "--depth",
        config.commitSha ? "50" : "1",
        "--branch",
        config.branch,
        cloneUrl,
        targetPath,
      ],
      { timeoutMs: GIT_CLONE_IDLE_TIMEOUT_MS, onLog, env: gitEnv },
    );

    if (config.commitSha) {
      await spawnGit(
        ["-c", "credential.helper=", "-C", targetPath, "checkout", config.commitSha],
        { timeoutMs: GIT_CHECKOUT_IDLE_TIMEOUT_MS, onLog, env: gitEnv },
      );
    }

    await rm(join(targetPath, ".git"), { recursive: true, force: true });
  } finally {
    if (sshDir) await rm(sshDir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface DockerBuildContext {
  contextDir: string;
  contextEntries: string[];
  dockerfileName: string;
  rootDirectory: string;
  usesRepositoryDockerfile: boolean;
  cleanup(): Promise<void>;
}

/**
 * A cloned + pruned source tree on the orchestrator, ready to build one OR
 * MORE images from. Separated from Dockerfile resolution so a compose/monorepo
 * stack can clone the repo ONCE and build every service against this single
 * tree instead of re-cloning per service.
 */
export interface SourceTree {
  contextDir: string;
  cleanup(): Promise<void>;
}

/** Per-image Dockerfile resolution result within an already-prepared tree. */
export interface ResolvedDockerfile {
  contextEntries: string[];
  dockerfileName: string;
  rootDirectory: string;
  usesRepositoryDockerfile: boolean;
}

/**
 * Materialize the source into a fresh temp dir as the Docker build context —
 * ONCE. The tree is EXACTLY git's tracked set (local: `git ls-files`; clone: a
 * clean checkout, tracked by construction), then a `.dockerignore` refinement.
 * No name-list / gitignore-pattern pruning — git already knows source-vs-
 * generated, so a tracked `build/`/`dist/` route is never dropped. No Dockerfile
 * resolution here: that is per-image (see resolveServiceDockerfile).
 */
export async function prepareSourceTree(
  config: BuildConfig,
  opts?: { onLog?: LogCallback },
): Promise<SourceTree> {
  const contextDir = await mkdtemp(join(tmpdir(), "openship-docker-context-"));

  try {
    if (config.localPath) {
      await materializeLocalSource(config.localPath, contextDir);
    } else {
      // Pass the log callback so the clone's stderr/progress lines land in the
      // build-log stream. A fresh clone already contains only tracked files, so
      // there's nothing to prune (pruning by name/gitignore would delete tracked
      // source — the exact bug this rewrite removes).
      await cloneGitSource(config, contextDir, opts?.onLog);
    }

    // Docker-only refinement: dockerode tars the context as-is, so honor
    // .dockerignore here. No-op when the repo has none.
    await applyDockerignore(contextDir);

    return {
      contextDir,
      cleanup: async () => {
        await rm(contextDir, { recursive: true, force: true }).catch(() => {});
      },
    };
  } catch (error) {
    await rm(contextDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Resolve (or generate) the Dockerfile for ONE image inside an
 * already-prepared tree. `generatedName` lets concurrent per-service builds
 * each write their own generated Dockerfile into the shared tree without
 * clobbering one another; it defaults to the single-image name.
 */
export async function resolveServiceDockerfile(
  contextDir: string,
  config: BuildConfig,
  opts?: { requireRepositoryDockerfile?: boolean; generatedName?: string },
): Promise<ResolvedDockerfile> {
  const requireRepositoryDockerfile = opts?.requireRepositoryDockerfile ?? false;
  const generatedName = opts?.generatedName ?? GENERATED_DOCKERFILE_NAME;

  const resolvedRootDirectory = await resolveDockerRootDirectory(
    contextDir,
    config.rootDirectory,
    config.localPath,
  );

  const repositoryDockerfileName = await resolveDockerfileName(
    contextDir,
    resolvedRootDirectory,
    config.dockerfilePath,
  );
  const hasRepositoryDockerfile = repositoryDockerfileName !== null;

  if (!hasRepositoryDockerfile && requireRepositoryDockerfile) {
    const expectedDockerfile = config.dockerfilePath?.trim() || "Dockerfile";
    throw new Error(
      `No Dockerfile found for this build context. Expected ${expectedDockerfile}${config.rootDirectory ? ` under ${config.rootDirectory}` : ""}.`,
    );
  }

  if (!hasRepositoryDockerfile) {
    await writeFile(
      join(contextDir, generatedName),
      generateDockerfile({
        ...config,
        rootDirectory: resolvedRootDirectory,
      }),
      "utf-8",
    );
  }

  const contextEntries = await readdir(contextDir);

  return {
    contextEntries,
    dockerfileName: repositoryDockerfileName ?? generatedName,
    rootDirectory: resolvedRootDirectory,
    usesRepositoryDockerfile: hasRepositoryDockerfile,
  };
}

/**
 * Single-image build context = prepare the tree + resolve one Dockerfile.
 * Kept as the composition of the two primitives above so the single-app path
 * is unchanged while compose/monorepo builds reuse `prepareSourceTree` once.
 */
export async function createDockerBuildContext(
  config: BuildConfig,
  opts?: { requireRepositoryDockerfile?: boolean; onLog?: LogCallback },
): Promise<DockerBuildContext> {
  const tree = await prepareSourceTree(config, { onLog: opts?.onLog });
  try {
    const resolved = await resolveServiceDockerfile(tree.contextDir, config, {
      requireRepositoryDockerfile: opts?.requireRepositoryDockerfile,
    });
    return {
      contextDir: tree.contextDir,
      contextEntries: resolved.contextEntries,
      dockerfileName: resolved.dockerfileName,
      rootDirectory: resolved.rootDirectory,
      usesRepositoryDockerfile: resolved.usesRepositoryDockerfile,
      cleanup: tree.cleanup,
    };
  } catch (error) {
    await tree.cleanup();
    throw error;
  }
}
