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
