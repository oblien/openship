/** Node filesystem helpers shared by native staging and remote SDK uploads. No engine bootstrap. */
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createWriteStream, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pipeline } from "node:stream/promises";
import { create as createTar } from "tar";
import { ValidationError, type CodeSource } from "@repo/contracts";

export const SOURCE_EXCLUSIONS = new Set(["node_modules", ".git", ".DS_Store"]);
export const MAX_SOURCE_BYTES = 300_000_000;
export const MAX_SOURCE_ENTRIES = 100_000;

function assertContained(root: string, path: string): void {
  const target = relative(root, path);
  if (target === ".." || target.startsWith("../") || target.startsWith("..\\") || isAbsolute(target))
    throw new ValidationError("Source symlinks must remain inside the selected directory");
}

/** Resolve a not-yet-created staging root through its existing symlink parents. */
async function plannedRealpath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return join(await plannedRealpath(dirname(path)), basename(path));
  }
}

/** An archive must never discover its own growing output or earlier upload debris. */
export async function assertSourceStagingOutside(directory: string, temporaryRoot = tmpdir()) {
  const canonical = await realpath(directory);
  const root = await plannedRealpath(resolve(temporaryRoot));
  const target = relative(canonical, root);
  if (target === "" || (!isAbsolute(target) && target !== ".." && !target.startsWith("../") && !target.startsWith("..\\"))) {
    throw new ValidationError(
      "Cannot upload the temporary directory or a folder containing it. Select the project's source directory, or set TMPDIR outside it.",
    );
  }
  return { directory: canonical, root };
}

export function sourceFileEntries(source: CodeSource): Array<[string, string | Uint8Array]> | null {
  if (source?.type === "directory" && typeof source.path === "string" && source.path.trim()) return null;
  if (source?.type !== "files" || !source.files || typeof source.files !== "object" || Array.isArray(source.files))
    throw new ValidationError("A directory or generated files source is required");
  let total = 0;
  const entries = Object.entries(source.files).map(([path, data]): [string, string | Uint8Array] => {
    if (!path || path.includes("\\") || path.includes("\0") || isAbsolute(path) || /^[a-z]:/i.test(path) || path.split("/").some(p => !p || p === "." || p === ".."))
      throw new ValidationError("Generated file paths must be relative and cannot traverse directories");
    if (typeof data !== "string" && !(data instanceof Uint8Array)) throw new ValidationError("Generated file contents must be strings or Uint8Array values");
    total += typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    if (total > MAX_SOURCE_BYTES) throw new ValidationError("Source exceeds the 300MB limit");
    return [path, typeof data === "string" ? data : new Uint8Array(data)];
  });
  if (!entries.length) throw new ValidationError("At least one source file is required");
  if (entries.length > MAX_SOURCE_ENTRIES) throw new ValidationError("Source contains too many files");
  return entries;
}

export async function validateSourceDirectory(root: string, signal?: AbortSignal): Promise<string> {
  const canonical = await realpath(root);
  if (!(await lstat(canonical)).isDirectory()) throw new ValidationError("Source must be a directory");
  let total = 0, count = 0;
  async function visit(directory: string, parents: Set<string>): Promise<void> {
    const current = await realpath(directory);
    assertContained(canonical, current);
    if (parents.has(current)) throw new ValidationError("Source contains a symlink cycle");
    const ancestors = new Set(parents).add(current);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      signal?.throwIfAborted();
      if (SOURCE_EXCLUSIONS.has(entry.name)) continue;
      if (++count > MAX_SOURCE_ENTRIES) throw new ValidationError("Source contains too many files");
      const path = join(directory, entry.name);
      const resolved = await realpath(path);
      assertContained(canonical, resolved);
      const info = await lstat(resolved);
      if (info.isDirectory()) await visit(path, ancestors);
      else if (info.isFile()) {
        total += info.size;
        if (total > MAX_SOURCE_BYTES) throw new ValidationError("Source exceeds the 300MB limit");
      } else throw new ValidationError("Source contains an unsupported file: " + relative(canonical, path));
    }
  }
  await visit(canonical, new Set());
  return canonical;
}

export async function prepareSourceDirectory(source: CodeSource, options: { temporaryRoot?: string; signal?: AbortSignal; validatePath?: (path: string) => Promise<string> } = {}) {
  const entries = sourceFileEntries(source);
  let directory: string, temporary = false;
  if (entries) {
    const root = options.temporaryRoot ?? tmpdir();
    await mkdir(root, { recursive: true, mode: 0o700 });
    directory = await mkdtemp(join(root, "openship-source-"));
    temporary = true;
  } else {
    directory = resolve((source as { path: string }).path);
    if (options.validatePath) directory = await options.validatePath(directory);
  }
  const dispose = async () => { if (temporary) await rm(directory, { recursive: true, force: true }); };
  try {
    for (const [path, data] of entries ?? []) {
      options.signal?.throwIfAborted();
      const target = join(directory, path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, data, { flag: "wx", mode: 0o600 });
    }
    directory = await validateSourceDirectory(directory, options.signal);
    return { directory, temporary, dispose };
  } catch (error) { await dispose(); throw error; }
}

/** A source archive only excludes dependencies, Git metadata and OS noise. Build outputs remain. */
export async function archiveSourceDirectory(directory: string, options: { temporaryRoot?: string; signal?: AbortSignal } = {}) {
  const staging = await assertSourceStagingOutside(directory, options.temporaryRoot);
  const canonical = await validateSourceDirectory(staging.directory, options.signal);
  const root = staging.root;
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(root, "openship-upload-")), path = join(temporary, "source.tar.gz");
  const dispose = () => rm(temporary, { recursive: true, force: true });
  try {
    const archive = createTar({
      cwd: canonical, gzip: true, portable: true, strict: true, follow: true,
      filter(entry) {
        if (entry.split(/[\\/]/).some(part => SOURCE_EXCLUSIONS.has(part))) return false;
        assertContained(canonical, realpathSync(resolve(canonical, entry)));
        return true;
      },
    }, ["."]);
    await pipeline(archive, createWriteStream(path, { flags: "wx", mode: 0o600 }), { signal: options.signal });
    return { path, dispose };
  } catch (error) { await dispose(); throw error; }
}
