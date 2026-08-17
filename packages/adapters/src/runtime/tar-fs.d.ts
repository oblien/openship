/**
 * Minimal ambient types for `tar-fs` (v2), the tar packer dockerode uses
 * internally. We depend on it directly only to build the Docker build-context
 * pack OURSELVES so we can attach an `'error'` handler dockerode never adds —
 * see `packBuildContext` in docker.ts (#448). Only the surface we use is typed;
 * `tar-fs` ships no declarations and `@types/tar-fs` isn't vendored here.
 */
declare module "tar-fs" {
  import type { Readable } from "node:stream";

  interface PackHeader {
    name: string;
    type?: string;
    mode?: number;
    uid?: number;
    gid?: number;
    uname?: string;
    gname?: string;
    mtime?: Date;
  }

  interface PackOptions {
    /** Top-level entry names to include (mirrors dockerode's `file.src`). */
    entries?: string[];
    /** Return true to skip a path during the walk. */
    ignore?: (name: string) => boolean;
    dereference?: boolean;
    /** Normalize headers so two packs of the same tree are byte-identical. */
    map?: (header: PackHeader) => PackHeader;
  }

  /** Pack a directory into a tar stream (a tar-stream `Pack`, i.e. a Readable). */
  export function pack(cwd: string, opts?: PackOptions): Readable;
}
