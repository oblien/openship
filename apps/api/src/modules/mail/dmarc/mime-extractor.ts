import * as zlib from "node:zlib";
import { DmarcParseError, DmarcSecurityError } from "./types";

const MAX_COMPRESSED_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_DECOMPRESSED_BYTES = 25 * 1024 * 1024; // 25 MB

/** Magic byte signatures */
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export interface ExtractedDmarcPayload {
  filename?: string;
  xml: string;
}

/** Safely decompress a GZIP buffer enforcing byte limits. */
export function decompressGzip(buf: Buffer): string {
  if (buf.length > MAX_COMPRESSED_BYTES) {
    throw new DmarcSecurityError(`Compressed GZIP payload exceeds limit of ${MAX_COMPRESSED_BYTES} bytes.`);
  }

  try {
    const decompressed = zlib.gunzipSync(buf, {
      maxOutputLength: MAX_DECOMPRESSED_BYTES,
    });
    return decompressed.toString("utf-8");
  } catch (err) {
    if (err instanceof Error && /maxOutputLength|quota|too large/i.test(err.message)) {
      throw new DmarcSecurityError(`Decompressed GZIP XML exceeds maximum size limit of ${MAX_DECOMPRESSED_BYTES} bytes.`);
    }
    throw new DmarcParseError(`Failed to decompress GZIP payload: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Safely extract XML from a ZIP buffer enforcing byte limits. */
export function decompressZip(buf: Buffer): { filename: string; xml: string } {
  if (buf.length > MAX_COMPRESSED_BYTES) {
    throw new DmarcSecurityError(`Compressed ZIP payload exceeds limit of ${MAX_COMPRESSED_BYTES} bytes.`);
  }

  // Parse ZIP Local File Header (PK\x03\x04)
  let offset = 0;
  while (offset < buf.length - 30) {
    if (
      buf[offset] === 0x50 &&
      buf[offset + 1] === 0x4b &&
      buf[offset + 2] === 0x03 &&
      buf[offset + 3] === 0x04
    ) {
      const compressionMethod = buf.readUInt16LE(offset + 8);
      const compressedSize = buf.readUInt32LE(offset + 18);
      const uncompressedSize = buf.readUInt32LE(offset + 22);
      const filenameLength = buf.readUInt16LE(offset + 26);
      const extraLength = buf.readUInt16LE(offset + 28);

      if (uncompressedSize > MAX_DECOMPRESSED_BYTES) {
        throw new DmarcSecurityError(
          `Uncompressed ZIP entry size (${uncompressedSize} bytes) exceeds limit of ${MAX_DECOMPRESSED_BYTES} bytes.`,
        );
      }

      const filenameStart = offset + 30;
      const filename = buf.toString("utf-8", filenameStart, filenameStart + filenameLength);
      const dataStart = filenameStart + filenameLength + extraLength;

      let extractedBuf: Buffer;
      if (compressionMethod === 0) {
        // Stored (no compression)
        extractedBuf = buf.subarray(dataStart, dataStart + uncompressedSize);
      } else if (compressionMethod === 8) {
        // Deflated
        const compressedData = buf.subarray(dataStart, dataStart + compressedSize);
        try {
          extractedBuf = zlib.inflateRawSync(compressedData, {
            maxOutputLength: MAX_DECOMPRESSED_BYTES,
          });
        } catch (err) {
          throw new DmarcParseError(`Failed to inflate ZIP entry: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        throw new DmarcParseError(`Unsupported ZIP compression method: ${compressionMethod}`);
      }

      return {
        filename,
        xml: extractedBuf.toString("utf-8"),
      };
    }
    offset++;
  }

  throw new DmarcParseError("No valid file entries found in ZIP archive.");
}

/** Decode base64 or quoted-printable body string */
function decodeMimeBody(body: string, encoding: string): Buffer {
  const enc = encoding.toLowerCase().trim();
  if (enc === "base64") {
    // Strip whitespace/newlines from base64
    const clean = body.replace(/\s+/g, "");
    return Buffer.from(clean, "base64");
  }
  if (enc === "quoted-printable") {
    const unquoted = body
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    return Buffer.from(unquoted, "binary");
  }
  return Buffer.from(body, "utf-8");
}

interface MimePart {
  headers: Record<string, string>;
  body: string;
}

function parseMimeHeaders(headerSection: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const lines = headerSection.split(/\r?\n/);
  let currentKey = "";

  for (const line of lines) {
    if (/^\s+/.test(line) && currentKey) {
      headers[currentKey] += " " + line.trim();
    } else {
      const idx = line.indexOf(":");
      if (idx !== -1) {
        currentKey = line.slice(0, idx).toLowerCase().trim();
        headers[currentKey] = line.slice(idx + 1).trim();
      }
    }
  }
  return headers;
}

function extractMultipartParts(body: string, boundary: string): MimePart[] {
  const parts: MimePart[] = [];
  const delimiter = `--${boundary}`;
  const rawParts = body.split(delimiter);

  for (const part of rawParts) {
    const trimmed = part.trim();
    if (!trimmed || trimmed === "--") continue;

    const splitIdx = trimmed.indexOf("\r\n\r\n");
    const altSplitIdx = trimmed.indexOf("\n\n");
    const headerEnd = splitIdx !== -1 ? splitIdx : altSplitIdx;

    if (headerEnd === -1) continue;

    const headerSection = trimmed.slice(0, headerEnd);
    const bodySection = trimmed.slice(headerEnd + (splitIdx !== -1 ? 4 : 2));

    parts.push({
      headers: parseMimeHeaders(headerSection),
      body: bodySection,
    });
  }

  return parts;
}

/**
 * Extract DMARC aggregate XML from raw email message or direct archive/xml buffer.
 */
export function extractDmarcXmlFromMessage(input: Buffer | string): ExtractedDmarcPayload {
  const buf = typeof input === "string" ? Buffer.from(input) : input;

  // 1. Check if input is directly GZIP
  if (buf.length >= 2 && buf[0] === GZIP_MAGIC[0] && buf[1] === GZIP_MAGIC[1]) {
    return { xml: decompressGzip(buf) };
  }

  // 2. Check if input is directly ZIP
  if (
    buf.length >= 4 &&
    buf[0] === ZIP_MAGIC[0] &&
    buf[1] === ZIP_MAGIC[1] &&
    buf[2] === ZIP_MAGIC[2] &&
    buf[3] === ZIP_MAGIC[3]
  ) {
    const res = decompressZip(buf);
    return { filename: res.filename, xml: res.xml };
  }

  const rawStr = buf.toString("utf-8");

  // 3. Check if input is directly XML
  if (/^\s*(<\?xml|<feedback)/i.test(rawStr)) {
    return { xml: rawStr };
  }

  // 4. Parse as RFC822 MIME message
  const splitIdx = rawStr.indexOf("\r\n\r\n");
  const altSplitIdx = rawStr.indexOf("\n\n");
  const headerEnd = splitIdx !== -1 ? splitIdx : altSplitIdx;

  if (headerEnd !== -1) {
    const headers = parseMimeHeaders(rawStr.slice(0, headerEnd));
    const messageBody = rawStr.slice(headerEnd + (splitIdx !== -1 ? 4 : 2));

    const contentType = headers["content-type"] || "";
    const boundaryMatch = contentType.match(/boundary=["']?([^"';]+)["']?/i);

    if (boundaryMatch && boundaryMatch[1]) {
      const parts = extractMultipartParts(messageBody, boundaryMatch[1]);
      for (const part of parts) {
        const partContentType = part.headers["content-type"] || "";
        const partDisposition = part.headers["content-disposition"] || "";
        const transferEncoding = part.headers["content-transfer-encoding"] || "7bit";

        const filenameMatch =
          partDisposition.match(/filename=["']?([^"';]+)["']?/i) ||
          partContentType.match(/name=["']?([^"';]+)["']?/i);
        const filename = filenameMatch ? filenameMatch[1] : undefined;

        const decoded = decodeMimeBody(part.body, transferEncoding);

        // Check if attachment is GZIP
        if (decoded.length >= 2 && decoded[0] === GZIP_MAGIC[0] && decoded[1] === GZIP_MAGIC[1]) {
          return {
            filename,
            xml: decompressGzip(decoded),
          };
        }

        // Check if attachment is ZIP
        if (
          decoded.length >= 4 &&
          decoded[0] === ZIP_MAGIC[0] &&
          decoded[1] === ZIP_MAGIC[1] &&
          decoded[2] === ZIP_MAGIC[2] &&
          decoded[3] === ZIP_MAGIC[3]
        ) {
          const zipRes = decompressZip(decoded);
          return {
            filename: filename || zipRes.filename,
            xml: zipRes.xml,
          };
        }

        // Plain XML attachment
        const text = decoded.toString("utf-8");
        if (/<feedback/i.test(text)) {
          return {
            filename,
            xml: text,
          };
        }
      }
    }
  }

  throw new DmarcParseError("Could not find a valid DMARC XML report attachment in the message.");
}
