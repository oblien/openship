import { renameSync, unlinkSync, writeFileSync } from "node:fs";

/**
 * Write JSON via temp + rename so a crash cannot leave a truncated dest.
 * Same-directory rename is atomic on POSIX. Windows cannot rename over an
 * existing path, so we unlink first there (still never truncates dest in place).
 */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, payload);
  try {
    renameSync(tmp, filePath);
    return;
  } catch {
    // Windows: dest exists
  }
  try {
    unlinkSync(filePath);
  } catch {
    // dest may not exist
  }
  try {
    renameSync(tmp, filePath);
  } catch {
    writeFileSync(filePath, payload);
    try {
      unlinkSync(tmp);
    } catch {
      // tmp already gone
    }
  }
}
