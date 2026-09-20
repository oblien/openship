/** Directory discovery uses the same native root policy as source registration. */
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AppError, OperationError } from "@repo/contracts";
import { MANIFEST_FILES } from "../../lib/stack-detector";
import { assertNativeSourcePath, defaultNativeSourceRoot } from "../../native/source-policy";
import { assertSelfHosted } from "./server-access";

const PROJECT_MARKERS = new Set(["package.json", "docker-compose.yml", "docker-compose.yaml", ...MANIFEST_FILES]);

export async function browseDirectories(input: { path?: string } = {}) {
  assertSelfHosted();
  const native = process.env.OPENSHIP_NATIVE === "true";
  const raw = input.path || (native ? defaultNativeSourceRoot() : homedir());
  let dirPath = resolve(raw);
  try {
    if (native) dirPath = await assertNativeSourcePath(dirPath);
    const st = await stat(dirPath);
    if (!st.isDirectory()) throw new OperationError("Not a directory", 400, "NOT_A_DIRECTORY");
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new OperationError("Directory not found", 404, "NOT_FOUND");
  }
  const entries = await readdir(dirPath, { withFileTypes: true });
  const directories: { name: string; path: string; isProject: boolean }[] = [];
  await Promise.all(entries.filter(entry => entry.isDirectory() && !entry.name.startsWith(".")).map(async entry => {
    const childPath = join(dirPath, entry.name);
    let isProject = false;
    if (native) {
      // Also check children in case an entry changed to a symlink since readdir.
      try { await assertNativeSourcePath(childPath); } catch { return; }
    }
    try { isProject = (await readdir(childPath)).some(marker => PROJECT_MARKERS.has(marker)); }
    catch { /* An unreadable child remains selectable without a project marker. */ }
    directories.push({ name: entry.name, path: childPath, isProject });
  }));
  directories.sort((a, b) => a.isProject !== b.isProject ? a.isProject ? -1 : 1 : a.name.localeCompare(b.name));
  return { path: dirPath, directories };
}
