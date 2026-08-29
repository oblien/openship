import { describe, it, expect } from "vitest";
import * as zlib from "node:zlib";
import {
  extractDmarcXmlFromMessage,
  decompressGzip,
  decompressZip,
} from "../../../../src/modules/mail/dmarc/mime-extractor";
import { DmarcSecurityError } from "../../../../src/modules/mail/dmarc/types";

/** Helper to construct a minimal valid ZIP archive in memory */
function createMinimalZip(filename: string, content: string): Buffer {
  const contentBuf = Buffer.from(content, "utf-8");
  const filenameBuf = Buffer.from(filename, "utf-8");
  const compressed = zlib.deflateRawSync(contentBuf);

  // Local File Header
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); // PK\x03\x04
  header.writeUInt16LE(20, 4); // version needed
  header.writeUInt16LE(0, 6); // flags
  header.writeUInt16LE(8, 8); // method = 8 (deflate)
  header.writeUInt16LE(0, 10); // mod time
  header.writeUInt16LE(0, 12); // mod date
  header.writeUInt32LE(0, 14); // crc32
  header.writeUInt32LE(compressed.length, 18); // compressed size
  header.writeUInt32LE(contentBuf.length, 22); // uncompressed size
  header.writeUInt16LE(filenameBuf.length, 26); // filename length
  header.writeUInt16LE(0, 28); // extra field length

  return Buffer.concat([header, filenameBuf, compressed]);
}

describe("DMARC MIME and Archive Extractor", () => {
  const sampleXml = `<feedback><report_metadata><org_name>test</org_name><report_id>1</report_id><date_range><begin>0</begin><end>0</end></date_range></report_metadata><policy_published><domain>test.com</domain><p>none</p></policy_published></feedback>`;

  describe("direct buffer extraction", () => {
    it("extracts from plain XML buffer", () => {
      const result = extractDmarcXmlFromMessage(Buffer.from(sampleXml));
      expect(result.xml).toBe(sampleXml);
    });

    it("decompresses GZIP payload", () => {
      const gzipped = zlib.gzipSync(Buffer.from(sampleXml));
      const extracted = decompressGzip(gzipped);
      expect(extracted).toBe(sampleXml);

      const result = extractDmarcXmlFromMessage(gzipped);
      expect(result.xml).toBe(sampleXml);
    });

    it("decompresses ZIP payload", () => {
      const zipBuf = createMinimalZip("google.com!example.com!1672531200!1672617600.xml", sampleXml);
      const res = decompressZip(zipBuf);
      expect(res.filename).toBe("google.com!example.com!1672531200!1672617600.xml");
      expect(res.xml).toBe(sampleXml);

      const result = extractDmarcXmlFromMessage(zipBuf);
      expect(result.xml).toBe(sampleXml);
    });
  });

  describe("RFC822 MIME message extraction", () => {
    it("extracts GZIP attachment from multipart MIME email", () => {
      const gzipped = zlib.gzipSync(Buffer.from(sampleXml));
      const base64Gzip = gzipped.toString("base64");

      const rawEmail = `From: dmarc-noreply@yahooinc.com
To: postmaster@example.com
Subject: Report Domain: example.com Submitter: yahoo.com
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="===============1234567890=="

--===============1234567890==
Content-Type: text/plain; charset="us-ascii"
Content-Transfer-Encoding: 7bit

This is a DMARC aggregate report from Yahoo.

--===============1234567890==
Content-Type: application/gzip
Content-Disposition: attachment; filename="yahoo.com!example.com!1672531200!1672617600.xml.gz"
Content-Transfer-Encoding: base64

${base64Gzip}

--===============1234567890==--
`;

      const result = extractDmarcXmlFromMessage(rawEmail);
      expect(result.filename).toBe("yahoo.com!example.com!1672531200!1672617600.xml.gz");
      expect(result.xml).toBe(sampleXml);
    });

    it("extracts ZIP attachment from Google style MIME email", () => {
      const zipBuf = createMinimalZip("google.com!example.com!1672531200!1672617600.zip", sampleXml);
      const base64Zip = zipBuf.toString("base64");

      const rawEmail = `From: noreply-dmarc-support@google.com
To: postmaster@example.com
Subject: Report Domain: example.com Submitter: google.com
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="Google_DMARC_Boundary"

--Google_DMARC_Boundary
Content-Type: text/plain; charset="utf-8"

This is a DMARC aggregate report from Google.

--Google_DMARC_Boundary
Content-Type: application/zip; name="google.com!example.com!1672531200!1672617600.zip"
Content-Disposition: attachment; filename="google.com!example.com!1672531200!1672617600.zip"
Content-Transfer-Encoding: base64

${base64Zip}

--Google_DMARC_Boundary--
`;

      const result = extractDmarcXmlFromMessage(rawEmail);
      expect(result.filename).toBe("google.com!example.com!1672531200!1672617600.zip");
      expect(result.xml).toBe(sampleXml);
    });
  });

  describe("DoS protections", () => {
    it("enforces compressed payload limits", () => {
      const oversizedBuf = Buffer.alloc(11 * 1024 * 1024); // 11MB
      expect(() => decompressGzip(oversizedBuf)).toThrow(DmarcSecurityError);
      expect(() => decompressZip(oversizedBuf)).toThrow(DmarcSecurityError);
    });
  });
});
