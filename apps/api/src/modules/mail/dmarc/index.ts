import { extractDmarcXmlFromMessage } from "./mime-extractor";
import { parseDmarcXml } from "./xml-parser";
import type { DmarcExtractionResult } from "./types";

export * from "./types";
export { parseDmarcXml } from "./xml-parser";
export { extractDmarcXmlFromMessage, decompressGzip, decompressZip } from "./mime-extractor";

/**
 * End-to-end extraction and parsing of a DMARC aggregate report from a raw email,
 * GZIP archive, ZIP archive, or raw XML payload.
 */
export function parseDmarcReportFromMessage(input: Buffer | string): DmarcExtractionResult {
  const { filename, xml } = extractDmarcXmlFromMessage(input);
  const report = parseDmarcXml(xml);
  return {
    filename,
    rawXml: xml,
    report,
  };
}
