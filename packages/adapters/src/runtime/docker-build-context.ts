import { spawn } from "node:child_process";
import { access, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

import ignore from "ignore";

import type { BuildConfig, LogCallback } from "../types";

import { getTarCreateEnv, prepareSourceTarArgs } from "../archive";
import { assembleGitClone } from "./build-pipeline";
import { localGitSshWriter, materializeGitSsh, type GitSshMaterial } from "./git-ssh-material";
import { generateDockerfile } from "./docker-build-plan";
import { dockerfileNeedsBuildKit } from "./docker-buildkit-trace";
import {
  dockerBuildContextDirectory,
  normalizeDockerRelativePath,
  resolveContextDockerfileCandidates,
  resolveDockerfileCandidates,
  resolveDockerRootDirectory,
  resolveWithinDirectory,
} from "./docker-paths";

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
 * Anchor one `.dockerignore` line to the context root. Docker matches patterns
 * against the whole context-relative path — a slash-less `node_modules` is the
 * root one only, and a leading globstar is what reaches any depth — while the
 * `ignore` package applies gitignore rules, where the slash-less form matches
 * at every depth. Patterns that already carry a slash, leading globstars,
 * comments and `!` negations are passed through unchanged.
 */
function anchorDockerignorePattern(line: string): string {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return line;

  const negated = trimmed.startsWith("!");
  const pattern = negated ? trimmed.slice(1) : trimmed;
  if (!pattern || pattern.startsWith("/") || pattern.startsWith("**/")) return line;
  if (pattern.replace(/\/+$/, "").includes("/")) return line;

  return `${negated ? "!" : ""}/${pattern}`;
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
    const contents = await readFile(join(rootPath, ".dockerignore"), "utf-8");
    return ignore().add(contents.split(/\r?\n/).map(anchorDockerignorePattern));
  } catch {
    return undefined; // no .dockerignore
  }
}

/** The build files (`.dockerignore` plus every Dockerfile candidate this config
 *  can resolve to) and the directories leading to them, in posix form. */
function buildFilePaths(config: BuildConfig): Set<string> {
  const paths = new Set<string>([".dockerignore"]);

  const candidates = resolveDockerfileCandidates(config.rootDirectory, config.dockerfilePath);

  for (const candidate of candidates) {
    const segments = candidate.split("/");
    for (let depth = 1; depth <= segments.length; depth += 1) {
      paths.add(segments.slice(0, depth).join("/"));
    }
  }

  return paths;
}

/** The build files inside a NARROWED context: `.dockerignore` plus the resolved
 *  Dockerfile and the directories leading to it. Docker sends those to the builder
 *  regardless of `.dockerignore`, and the daemon reads the Dockerfile out of the
 *  tar we pack — dropping it would fail the build outright. */
function contextKeepPaths(dockerfileName: string): Set<string> {
  const paths = new Set<string>([".dockerignore"]);
  const segments = dockerfileName.split("/").filter(Boolean);

  for (let depth = 1; depth <= segments.length; depth += 1) {
    paths.add(segments.slice(0, depth).join("/"));
  }

  return paths;
}

/**
 * A `.dockerignore` predicate for a build context whose tree was NOT pruned
 * destructively — the shared-tree case, where one service's `.dockerignore` must
 * not delete files another service's context needs.
 *
 * Only the dockerode path needs this: the remote path runs the real `docker build`
 * inside the context dir, and the CLI applies that context's `.dockerignore`
 * itself. Returns undefined when the context has no `.dockerignore`.
 */
async function loadContextIgnore(
  buildContextDir: string,
  keep: Set<string>,
): Promise<((relativePosixPath: string) => boolean) | undefined> {
  const matcher = await loadDockerignoreMatcher(buildContextDir);
  if (!matcher) return undefined;

  return (relativePosixPath: string) =>
    !keep.has(relativePosixPath) && matcher.ignores(relativePosixPath);
}

/**
 * The absolute docker build context for a source tree, PROVEN to be inside it.
 *
 * `resolveWithinDirectory` already rejects `..` and absolute input lexically; the
 * realpath compare closes the symlink hole that only opens once the context can be
 * a subdirectory — a repo may legitimately track `svc -> /etc`, and `cd`-ing there
 * on the build host would hand arbitrary host files to the build (the same class as
 * GHSA-443m-7g52-94w8). The LEXICAL path is what we return: the tree itself is a
 * mkdtemp whose realpath differs from its own path on macOS, so mixing the two
 * would break every `relative()` computed against it downstream.
 */
async function resolveBuildContextDir(treeDir: string, contextSubdir: string): Promise<string> {
  const target = resolveWithinDirectory(treeDir, contextSubdir);
  if (!contextSubdir) return target;

  const stats = await stat(target).catch(() => null);
  if (!stats?.isDirectory()) {
    throw new Error(
      `Build context "${contextSubdir}" is not a directory in this source. Check the service's build path.`,
    );
  }

  const [realTree, realTarget] = await Promise.all([realpath(treeDir), realpath(target)]);
  const escape = relative(realTree, realTarget);
  if (escape === ".." || escape.startsWith(`..${sep}`) || isAbsolute(escape)) {
    throw new Error(`Build context "${contextSubdir}" resolves outside the source tree.`);
  }

  return target;
}

/** Remove everything matching `.dockerignore` from an already-materialized
 *  context tree, except the build files themselves — Docker sends those to the
 *  builder regardless. No-op when the repo has no `.dockerignore`. */
async function applyDockerignore(contextDir: string, config: BuildConfig): Promise<void> {
  const matcher = await loadDockerignoreMatcher(contextDir);
  if (!matcher) return;

  const buildFiles = buildFilePaths(config);

  const prune = async (currentPath: string): Promise<void> => {
    const entries = await readdir(currentPath, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const absolutePath = join(currentPath, entry.name);
        const relativePath = toPosixPath(relative(contextDir, absolutePath));
        if (!buildFiles.has(relativePath) && matcher.ignores(relativePath)) {
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
 *
 * `alsoInclude` is the necessary exception to git-truth, and BareRuntime's
 * transfer path already applied it for the same reason: a build output directory
 * is conventionally gitignored, so `git ls-files` omits it. That is harmless when
 * the build is about to regenerate it — and wrong when there is no build and those
 * files ARE the site. Without this a local static project whose `dist/` (or
 * `_site/`, `public/`) is gitignored built a context with its content missing:
 * the extract then found nothing at the output directory, or served a doc-root
 * that had everything except the site.
 */
async function materializeLocalSource(
  sourcePath: string,
  targetPath: string,
  outputDirectory?: string,
): Promise<void> {
  // A real SUBDIRECTORY only. "" and "." mean "the output is the source tree",
  // where there is nothing gitignored to re-add — and passing "." would re-add the
  // whole directory, discarding git-truth and shipping `node_modules` for every
  // stack whose outputDirectory is "." (most backend ones).
  const outDir = outputDirectory?.trim().replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
  const alsoInclude = outDir && outDir !== "." ? [outDir] : undefined;
  const { args, cleanup } = await prepareSourceTarArgs(sourcePath, { alsoInclude });
  try {
    await new Promise<void>((resolve, reject) => {
      const create = spawn("tar", args, { env: getTarCreateEnv() });
      const extract = spawn("tar", ["-xzf", "-", "-C", targetPath]);
      let err = "";
      // Keep the two sides' stderr apart. When the PACK fails (source vanished
      // mid-read, permission denied, disk full) the stream just ends early, and
      // the extract's "unexpected end of file" is the only thing that used to
      // surface — a symptom that says nothing about the cause. The pack's own
      // stderr is what names it, so it leads the message.
      let createErr = "";
      let createCode: number | null = null;
      create.stderr.on("data", (d) => (createErr += d.toString()));
      extract.stderr.on("data", (d) => (err += d.toString()));
      create.on("error", reject);
      extract.on("error", reject);
      create.on("close", (code) => (createCode = code));
      create.stdout.pipe(extract.stdin);
      extract.on("close", (code) => {
        if (code === 0 && (createCode ?? 0) === 0) return resolve();
        // A non-zero pack exit is the real failure even when the extract also
        // complains; report it first and keep the extract's output as context.
        const parts = [
          createCode ? `pack exited ${createCode}: ${createErr.trim().slice(-500)}` : "",
          code ? `extract exited ${code}: ${err.trim().slice(-500)}` : "",
        ].filter(Boolean);
        reject(new Error(`context materialize failed (${parts.join(" | ")})`));
      });
    });
  } finally {
    await cleanup();
  }
}

/** First candidate that exists inside `dir`, or null. Candidates are relative
 *  posix paths and are probed in priority order. */
async function firstExistingCandidate(dir: string, candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    const candidatePath = join(dir, ...candidate.split("/"));
    const exists = await access(candidatePath)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      return candidate;
    }
  }

  return null;
}

async function resolveDockerfileName(
  contextDir: string,
  rootDirectory?: string,
  explicitDockerfilePath?: string,
): Promise<string | null> {
  return firstExistingCandidate(
    contextDir,
    resolveDockerfileCandidates(rootDirectory, explicitDockerfilePath),
  );
}

async function cloneGitSource(
  config: BuildConfig,
  targetPath: string,
  onLog?: LogCallback,
): Promise<void> {
  // SSH mode (per-server key / deploy key): clone over git@github.com with a
  // 0600 key + pinned known_hosts in a local temp dir (removed in finally).
  // Normally SSH clones run ON the server; this is the orchestrator fallback.
  let sshMaterial: GitSshMaterial | undefined;
  if (config.gitSsh) {
    sshMaterial = await materializeGitSsh(
      localGitSshWriter(),
      await mkdtemp(join(tmpdir(), "opsh-ghkey-")),
      config.gitSsh,
    );
  }

  // Same assembly the on-server clones use (git-clone.ts), in argv form.
  // `config.gitAmbient` is deliberately NOT forwarded: it names credentials that
  // exist on the BUILD SERVER, and this clone runs on the orchestrator standing
  // in for it — the server's identity is not ours to use.
  const { cloneUrl, env: gitEnv, credArgs } = assembleGitClone({
    repoUrl: config.repoUrl,
    gitToken: config.gitToken,
    ssh: sshMaterial,
  });

  try {
    await spawnGit(
      [
        ...credArgs,
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
      await spawnGit([...credArgs, "-C", targetPath, "checkout", config.commitSha], {
        timeoutMs: GIT_CHECKOUT_IDLE_TIMEOUT_MS,
        onLog,
        env: gitEnv,
      });
    }

    await rm(join(targetPath, ".git"), { recursive: true, force: true });
  } finally {
    await sshMaterial?.cleanup();
  }
}

export interface DockerBuildContext extends ResolvedDockerfile {
  contextDir: string;
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
  /**
   * Whether `.dockerignore` was already applied DESTRUCTIVELY to this tree. False
   * when one or more builds narrow their context to a subdirectory: pruning the
   * shared tree by any single `.dockerignore` would delete files the other
   * contexts legitimately need, so each build filters its own context instead.
   */
  dockerignorePruned: boolean;
  cleanup(): Promise<void>;
}

/** Per-image Dockerfile resolution result within an already-prepared tree. */
export interface ResolvedDockerfile {
  /**
   * ABSOLUTE path to this image's docker build context. Equal to the tree's
   * `contextDir` unless the config narrows it with `buildContextDirectory`.
   */
  buildContextDir: string;
  /** `buildContextDir` relative to the tree, posix. "" = the tree root. */
  contextSubdir: string;
  /** Top-level names inside `buildContextDir`, `.dockerignore`-filtered when the
   *  tree itself was not pruned. */
  contextEntries: string[];
  /**
   * `.dockerignore` predicate for paths relative to `buildContextDir`, for packers
   * that must apply it themselves. Undefined when the tree was already pruned (or
   * the context has no `.dockerignore`) — nothing left to filter.
   */
  ignoreContextPath?: (relativePosixPath: string) => boolean;
  /** Dockerfile path relative to `buildContextDir` — what `-f` wants. */
  dockerfileName: string;
  rootDirectory: string;
  usesRepositoryDockerfile: boolean;
  /**
   * The resolved Dockerfile uses syntax the Engine API's CLASSIC builder rejects
   * outright (`RUN --mount`, a `# syntax=` directive, heredocs). The dockerode paths
   * use it to opt that ONE build onto BuildKit; every other build keeps the default
   * builder. Never set for a generated recipe — we write those, and they are plain.
   */
  requiresBuildKit: boolean;
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
  opts?: { onLog?: LogCallback; perServiceBuildContexts?: boolean },
): Promise<SourceTree> {
  const contextDir = await mkdtemp(join(tmpdir(), "openship-docker-context-"));

  try {
    // The destructive prune is only sound while the tree IS the build context. Once
    // any build in the batch narrows its context to a subdirectory, the source root's
    // `.dockerignore` is the WRONG file for it (compose reads the one in the context)
    // and the tree is shared, so pruning by any one of them would delete files the
    // others need — an allowlist root `.dockerignore` (`*` + `!src`) would empty the
    // tree and fail every sub-service build. Those builds filter their own context at
    // pack time instead; see `ignoreContextPath`.
    //
    // Inside the try because a malformed context value throws here, and the temp dir
    // is already on disk by then.
    const pruneDockerignore =
      !opts?.perServiceBuildContexts && !dockerBuildContextDirectory(config);

    if (config.localPath) {
      await materializeLocalSource(config.localPath, contextDir, config.outputDirectory);
    } else {
      // Pass the log callback so the clone's stderr/progress lines land in the
      // build-log stream. A fresh clone already contains only tracked files, so
      // there's nothing to prune (pruning by name/gitignore would delete tracked
      // source — the exact bug this rewrite removes).
      await cloneGitSource(config, contextDir, opts?.onLog);
    }

    // Docker-only refinement: dockerode tars the context as-is, so honor
    // .dockerignore here. No-op when the repo has none.
    if (pruneDockerignore) await applyDockerignore(contextDir, config);

    return {
      contextDir,
      dockerignorePruned: pruneDockerignore,
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
 * The one message for "you declared a build context and it has no Dockerfile".
 * Shared with the clone-on-server probe so the wording can't drift between a
 * build that resolves locally and one that resolves on the box.
 */
export function missingContextDockerfileMessage(
  contextSubdir: string,
  dockerfilePath?: string | null,
  opts?: { generatedRecipeRefused?: boolean; rootDockerfileExists?: boolean },
): string {
  const expected = normalizeDockerRelativePath(dockerfilePath) || "Dockerfile";
  const at = `${contextSubdir}/${expected.startsWith(`${contextSubdir}/`) ? expected.slice(contextSubdir.length + 1) : expected}`;

  return (
    `No Dockerfile found in the build context "${contextSubdir}". Expected ${at}.` +
    // Names the file the build used to fall back to. Before #634 a build dir with no
    // Dockerfile silently built the REPO ROOT's one under this service's tag, so an
    // upgrade turns those deploys from "green with the wrong image" to red — and
    // without this sentence the red gives no clue why.
    (opts?.rootDockerfileExists
      ? " The source root has a Dockerfile, but it is outside this service's build context, so it is not used — set the service's build path to the directory that holds the Dockerfile you want, or add one there."
      : "") +
    (opts?.generatedRecipeRefused
      ? " A declared build context builds from its own Dockerfile — Openship will not generate one for it, because a generated recipe copies from the source root."
      : "")
  );
}

/**
 * Resolve (or generate) the Dockerfile for ONE image inside an
 * already-prepared tree. `generatedName` lets concurrent per-service builds
 * each write their own generated Dockerfile into the shared tree without
 * clobbering one another; it defaults to the single-image name.
 *
 * `dockerignorePruned` mirrors {@link SourceTree.dockerignorePruned}: false means
 * this call must hand back the filter for its own context instead of relying on a
 * tree that was already cleaned.
 */
export async function resolveServiceDockerfile(
  contextDir: string,
  config: BuildConfig,
  opts?: {
    requireRepositoryDockerfile?: boolean;
    generatedName?: string;
    dockerignorePruned?: boolean;
    onLog?: LogCallback;
  },
): Promise<ResolvedDockerfile> {
  const requireRepositoryDockerfile = opts?.requireRepositoryDockerfile ?? false;
  const generatedName = opts?.generatedName ?? GENERATED_DOCKERFILE_NAME;
  const contextSubdir = dockerBuildContextDirectory(config);
  const buildContextDir = await resolveBuildContextDir(contextDir, contextSubdir);

  // A narrowed context makes `rootDirectory` moot — the context IS the root the
  // Dockerfile sees. Taking it verbatim also skips `resolveDockerRootDirectory`'s
  // filesystem auto-detect, which would otherwise wander the tree scoring
  // manifests to answer a question this build has already answered.
  const resolvedRootDirectory = contextSubdir
    ? contextSubdir
    : await resolveDockerRootDirectory(contextDir, config.rootDirectory, config.localPath);

  const repositoryDockerfileName = contextSubdir
    ? await firstExistingCandidate(
        buildContextDir,
        resolveContextDockerfileCandidates(contextSubdir, config.dockerfilePath),
      )
    : await resolveDockerfileName(contextDir, resolvedRootDirectory, config.dockerfilePath);
  const hasRepositoryDockerfile = repositoryDockerfileName !== null;

  // A generated recipe COPYs from the source root, so it cannot be satisfied by a
  // narrowed context — refuse regardless of `requireRepositoryDockerfile` rather
  // than write a Dockerfile that is guaranteed to fail mid-build.
  if (!hasRepositoryDockerfile && contextSubdir) {
    throw new Error(
      missingContextDockerfileMessage(contextSubdir, config.dockerfilePath, {
        generatedRecipeRefused: !requireRepositoryDockerfile,
        rootDockerfileExists: await access(join(contextDir, "Dockerfile"))
          .then(() => true)
          .catch(() => false),
      }),
    );
  }

  // The context's plain `Dockerfile` is the LAST candidate, so an explicit
  // `dockerfile` that resolved to it did not resolve to what was asked for. That
  // still builds — an absolute or stale value is worth rescuing rather than failing
  // — but it must not be silent: the alternative is shipping an image built from a
  // recipe nobody selected.
  const explicitDockerfile = normalizeDockerRelativePath(config.dockerfilePath);
  if (
    contextSubdir &&
    explicitDockerfile &&
    repositoryDockerfileName === "Dockerfile" &&
    explicitDockerfile !== "Dockerfile" &&
    explicitDockerfile !== `${contextSubdir}/Dockerfile`
  ) {
    opts?.onLog?.({
      timestamp: new Date().toISOString(),
      message: `Configured Dockerfile "${config.dockerfilePath}" was not found in build context "${contextSubdir}" — using ${contextSubdir}/Dockerfile instead.`,
      level: "warn",
    });
  }

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

  const dockerfileName = repositoryDockerfileName ?? generatedName;
  // Read only a repository Dockerfile: a generated recipe is ours and never uses
  // BuildKit-only syntax, so re-reading it back off disk would be pure cost. A read
  // failure here must not fail the build — the builder choice is an optimization,
  // and the build itself is about to read the same file.
  const requiresBuildKit = hasRepositoryDockerfile
    ? await readFile(join(buildContextDir, ...dockerfileName.split("/")), "utf-8")
        .then(dockerfileNeedsBuildKit)
        .catch(() => false)
    : false;
  const ignoreContextPath =
    opts?.dockerignorePruned === false
      ? await loadContextIgnore(buildContextDir, contextKeepPaths(dockerfileName))
      : undefined;
  // tar-fs applies its `ignore` predicate only to entries it DISCOVERS while
  // walking — the seed `entries` list is queued unconditionally — so the top level
  // has to be filtered here or a `.dockerignore`d root directory would still ship.
  const contextEntries = (await readdir(buildContextDir)).filter(
    (entry) => !ignoreContextPath?.(entry),
  );

  return {
    buildContextDir,
    contextSubdir,
    contextEntries,
    ignoreContextPath,
    dockerfileName,
    rootDirectory: resolvedRootDirectory,
    usesRepositoryDockerfile: hasRepositoryDockerfile,
    requiresBuildKit,
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
      dockerignorePruned: tree.dockerignorePruned,
      onLog: opts?.onLog,
    });
    return {
      ...resolved,
      contextDir: tree.contextDir,
      cleanup: tree.cleanup,
    };
  } catch (error) {
    await tree.cleanup();
    throw error;
  }
}
