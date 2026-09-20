/** Validate untrusted source archives before extracting into an owned empty directory. */
import { createReadStream } from "node:fs";
import { posix } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { Parser, extract } from "tar";
import { ValidationError } from "@repo/contracts";
import { MAX_SOURCE_BYTES, MAX_SOURCE_ENTRIES } from "./source-files";

export function sourceByteLimit(limit = MAX_SOURCE_BYTES): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > limit ? new ValidationError("Source archive exceeds its size limit") : null, chunk);
    },
  });
}

function memberPath(path: string): string {
  if (!path || path.length > 4096 || /[\\\0:]/.test(path) || path.startsWith("/") || path.startsWith("~") || path.split("/").includes(".."))
    throw new ValidationError("Source archive contains an unsafe path");
  return posix.normalize(path).replace(/\/$/, "");
}

export async function extractSourceArchive(archive: string, destination: string): Promise<void> {
  let bytes = 0, count = 0;
  let validationError: Error | undefined;
  const members = new Map<string, string>();
  const parser = new Parser({
    strict: true, maxMetaEntrySize: 1024 * 1024,
    onReadEntry(entry) {
      try {
        const path = memberPath(entry.path);
        if (++count > MAX_SOURCE_ENTRIES) throw new ValidationError("Source archive contains too many entries");
        if (!["File", "OldFile", "Directory", "Link"].includes(entry.type))
          throw new ValidationError("Source archives may contain only directories, files, and internal hard links");
        if (path === "." && entry.type !== "Directory") throw new ValidationError("Invalid archive root");
        if (members.has(path)) throw new ValidationError("Source archive contains duplicate paths");
        if (entry.type === "Link") {
          const type = members.get(memberPath(entry.linkpath ?? ""));
          if (type !== "File" && type !== "OldFile") throw new ValidationError("Source archive hard links must point to an earlier regular file");
        }
        if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new ValidationError("Invalid archive entry size");
        bytes += entry.size;
        if (bytes > MAX_SOURCE_BYTES) throw new ValidationError("Source exceeds the 300MB limit");
        members.set(path, entry.type);
      } catch (error) {
        validationError = error instanceof Error ? error : new Error(String(error));
        parser.abort(validationError);
      } finally {
        entry.resume();
      }
    },
  });
  // Bound decompressed bytes too: oversized padding and metadata must not bypass
  // the sum of file sizes. The archive is private and immutable between passes.
  try {
    await pipeline(createReadStream(archive), createGunzip(), sourceByteLimit(MAX_SOURCE_BYTES + MAX_SOURCE_ENTRIES * 1024 + 16 * 1024 * 1024), parser);
  } catch (error) {
    if (validationError) throw validationError;
    if (/^(?:TAR_|Z_)/.test(String((error as { code?: string }).code))) throw new ValidationError("Invalid source archive");
    throw error;
  }
  if (!members.size) throw new ValidationError("Source archive is empty");
  await extract({
    file: archive, cwd: destination, strict: true, preservePaths: false,
    preserveOwner: false, noChmod: true, maxMetaEntrySize: 1024 * 1024,
    filter(_path, entry) { entry.mode = (entry.mode ?? 0o644) & 0o777; return true; },
  });
}
