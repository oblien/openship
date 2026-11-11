import { lstat } from "node:fs/promises";
import type { FileStat } from "../types";

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;

/** Map a POSIX `st_mode` (fs.Stats or SFTP attrs) to a {@link FileStat}. */
export function fileStatOf(stats: { mode: number }): FileStat {
  const type = stats.mode & S_IFMT;
  const kind =
    type === S_IFREG
      ? "file"
      : type === S_IFLNK
        ? "symlink"
        : type === S_IFDIR
          ? "directory"
          : "other";
  return { kind, mode: stats.mode & 0o7777 };
}

/** Local counterpart of SFTP lstat: only absence becomes null. */
export async function lstatFile(path: string): Promise<FileStat | null> {
  try {
    return fileStatOf(await lstat(path));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}
