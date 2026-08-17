import { copyFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

/**
 * Write JSON via temp + rename so a crash cannot leave a truncated dest.
 * Same-directory rename is atomic on POSIX. Windows cannot rename over an
 * existing path, so dest is moved aside first and restored if the swap fails.
 * Never writes dest in place (that could truncate it).
 */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = `${filePath}.${process.pid}.tmp`;
  const bak = `${filePath}.bak`;
  writeFileSync(tmp, payload);
  try {
    renameSync(tmp, filePath);
    return;
  } catch {
    // dest exists (Windows) or the volumes differ (EXDEV)
  }

  unlinkQuiet(bak);
  try {
    renameSync(filePath, bak);
  } catch {
    unlinkQuiet(tmp);
    throw new Error(`Could not replace ${filePath}`);
  }

  try {
    renameSync(tmp, filePath);
  } catch {
    // EXDEV: copy onto dest's volume, then drop tmp.
    try {
      copyFileSync(tmp, filePath);
      unlinkQuiet(tmp);
    } catch (err) {
      try {
        renameSync(bak, filePath);
      } catch {
        // dest gone and bak restore failed
      }
      unlinkQuiet(tmp);
      throw err;
    }
  }
  unlinkQuiet(bak);
}
