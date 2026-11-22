import { isUploadIgnoredPath } from "@repo/core";

/**
 * Build a gzipped tar (.tar.gz) Blob entirely in the browser from a folder the
 * user picked via `<input webkitdirectory>` / drag-drop. Used by the
 * folder-upload deploy flow: the archive is streamed to an Oblien workspace
 * (SaaS) or the openship API (self-hosted), then the normal build pipeline runs.
 *
 * - Honors the shared source-ignore list (`isUploadIgnoredPath` from @repo/core)
 *   so `node_modules`, `.git`, build output, etc. never go over the wire.
 * - Long paths (>100 bytes) use a PAX extended header (`path=…`), the portable
 *   way GNU/BSD tar carries deep paths — so real-world nested projects pack
 *   correctly, not just shallow ones.
 * - gzip via the native `CompressionStream` (no dependency).
 */

const enc = new TextEncoder();
const BLOCK = 512;

function octal(value: number, fieldLen: number): Uint8Array {
  // Octal ASCII, zero-padded, NUL-terminated (fieldLen includes the NUL).
  return enc.encode(value.toString(8).padStart(fieldLen - 1, "0") + "\0");
}

function writeAscii(buf: Uint8Array, offset: number, str: string, max: number): void {
  buf.set(enc.encode(str).subarray(0, max), offset);
}

/** ustar header block (512 bytes) with a correct checksum. */
function header(name: string, size: number, typeflag: "0" | "x", mtime: number): Uint8Array {
  const h = new Uint8Array(BLOCK);
  writeAscii(h, 0, name, 100);
  h.set(octal(0o644, 8), 100); // mode
  h.set(octal(0, 8), 108); // uid
  h.set(octal(0, 8), 116); // gid
  h.set(octal(size, 12), 124); // size
  h.set(octal(mtime, 12), 136); // mtime
  for (let i = 148; i < 156; i++) h[i] = 0x20; // checksum field = spaces while summing
  h[156] = typeflag.charCodeAt(0);
  writeAscii(h, 257, "ustar", 6); // magic "ustar\0"
  h[263] = 0x30; // version "0"
  h[264] = 0x30; // version "0"

  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i]!;
  // Checksum: 6 octal digits, NUL, space.
  h.set(enc.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
  return h;
}

/** A PAX record: "<len> key=value\n", where <len> is the record's own byte length. */
function paxRecord(key: string, value: string): string {
  const rest = ` ${key}=${value}\n`;
  const restBytes = enc.encode(rest).length;
  let len = restBytes;
  while (String(len).length + restBytes !== len) {
    len = String(len).length + restBytes;
  }
  return String(len) + rest;
}

function pad(bytes: number): number {
  const rem = bytes % BLOCK;
  return rem === 0 ? 0 : BLOCK - rem;
}

export interface FolderFile {
  /** Repo-relative POSIX path (root folder segment already stripped). */
  path: string;
  file: File;
}

/**
 * Extract the includable files from a `webkitdirectory` FileList: strip the
 * leading root-folder segment from each `webkitRelativePath` and drop anything
 * the shared ignore list excludes.
 */
export function collectFolderFiles(files: FileList | File[]): FolderFile[] {
  const out: FolderFile[] = [];
  for (const file of Array.from(files)) {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    // "myapp/src/index.ts" → "src/index.ts"
    const slash = rel.indexOf("/");
    const path = slash >= 0 ? rel.slice(slash + 1) : rel;
    if (!path || isUploadIgnoredPath(path)) continue;
    out.push({ path, file });
  }
  return out;
}

/** Build the uncompressed tar as an array of byte chunks. */
async function buildTarParts(entries: FolderFile[]): Promise<Uint8Array[]> {
  const parts: Uint8Array[] = [];
  const zero = new Uint8Array(BLOCK);

  for (const { path, file } of entries) {
    const data = new Uint8Array(await file.arrayBuffer());
    const mtime = Math.floor((file.lastModified || 0) / 1000);
    const nameBytes = enc.encode(path).length;

    if (nameBytes > 100) {
      const body = enc.encode(paxRecord("path", path));
      parts.push(header("PaxHeader", body.length, "x", mtime));
      parts.push(body);
      const bodyPad = pad(body.length);
      if (bodyPad) parts.push(new Uint8Array(bodyPad));
      // Real entry: name is a best-effort truncation; tar uses the PAX path.
      parts.push(header(path.slice(-100), data.length, "0", mtime));
    } else {
      parts.push(header(path, data.length, "0", mtime));
    }

    parts.push(data);
    const dataPad = pad(data.length);
    if (dataPad) parts.push(new Uint8Array(dataPad));
  }

  // Two zero blocks terminate the archive.
  parts.push(zero, new Uint8Array(BLOCK));
  return parts;
}

/**
 * Pack the given files into a gzipped tar Blob. Returns the Blob plus the
 * count of files included (after ignore-filtering) for UI feedback.
 */
export async function buildFolderTarGz(
  files: FileList | File[],
): Promise<{ blob: Blob; fileCount: number }> {
  const entries = collectFolderFiles(files);
  if (entries.length === 0) {
    throw new Error("No files to upload after filtering — is the folder empty?");
  }
  const parts = await buildTarParts(entries);
  // Cast: TS 5.9 types these as Uint8Array<ArrayBufferLike>, which the DOM
  // BlobPart (BufferSource) union doesn't structurally accept, though every
  // chunk here is ArrayBuffer-backed and valid at runtime.
  const tar = new Blob(parts as unknown as BlobPart[], { type: "application/x-tar" });
  const gz = tar.stream().pipeThrough(new CompressionStream("gzip"));
  const blob = await new Response(gz).blob();
  return { blob, fileCount: entries.length };
}
