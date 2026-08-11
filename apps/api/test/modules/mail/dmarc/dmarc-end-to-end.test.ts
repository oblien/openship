import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { parseDmarcReportFromMessage } from "../../../../src/modules/mail/dmarc";

describe("DMARC End-to-End Report Ingestion", () => {
  const fixturesDir = path.join(__dirname, "fixtures");

  it("extracts and parses GZIP compressed Yahoo report email", () => {
    const xml = fs.readFileSync(path.join(fixturesDir, "yahoo-dmarc-report.xml"), "utf-8");
    const gzipped = zlib.gzipSync(Buffer.from(xml));

    const email = `From: dmarc-noreply@yahooinc.com
To: postmaster@example.com
Subject: Report Domain: example.com Submitter: yahoo.com
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="BOUNDARY"

--BOUNDARY
Content-Type: application/gzip
Content-Disposition: attachment; filename="yahoo.com!example.com!1672531200!1672617600.xml.gz"
Content-Transfer-Encoding: base64

${gzipped.toString("base64")}
--BOUNDARY--`;

    const result = parseDmarcReportFromMessage(email);

    expect(result.filename).toBe("yahoo.com!example.com!1672531200!1672617600.xml.gz");
    expect(result.report.metadata.orgName).toBe("Yahoo! Inc.");
    expect(result.report.policyPublished.p).toBe("reject");
    expect(result.report.records[0]?.row.sourceIp).toBe("2001:db8:85a3::8a2e:370:7334");
    expect(result.report.records[0]?.authResults.dkim[0]?.result).toBe("pass");
  });
});
