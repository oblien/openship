import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseDmarcXml } from "../../../../src/modules/mail/dmarc/xml-parser";
import { DmarcSecurityError, DmarcParseError } from "../../../../src/modules/mail/dmarc/types";

describe("DMARC XML Parser", () => {
  const fixturesDir = path.join(__dirname, "fixtures");

  it("parses Google DMARC aggregate XML accurately", () => {
    const xml = fs.readFileSync(path.join(fixturesDir, "google-dmarc-report.xml"), "utf-8");
    const report = parseDmarcXml(xml);

    expect(report.metadata.orgName).toBe("google.com");
    expect(report.metadata.email).toBe("noreply-dmarc-support@google.com");
    expect(report.metadata.reportId).toBe("1234567890123456789");
    expect(report.metadata.dateRange.begin).toEqual(new Date(1672531199000));
    expect(report.metadata.dateRange.end).toEqual(new Date(1672617599000));

    expect(report.policyPublished).toEqual({
      domain: "example.com",
      adkim: "r",
      aspf: "r",
      p: "quarantine",
      sp: "quarantine",
      pct: 100,
    });

    expect(report.records).toHaveLength(2);

    const first = report.records[0];
    expect(first.row.sourceIp).toBe("209.85.220.41");
    expect(first.row.count).toBe(15);
    expect(first.row.policyEvaluated.disposition).toBe("none");
    expect(first.row.policyEvaluated.dkim).toBe("pass");
    expect(first.row.policyEvaluated.spf).toBe("pass");
    expect(first.identifiers.headerFrom).toBe("example.com");
    expect(first.identifiers.envelopeTo).toBe("gmail.com");
    expect(first.authResults.dkim).toEqual([
      { domain: "example.com", result: "pass", selector: "s1" },
    ]);
    expect(first.authResults.spf).toEqual([
      { domain: "example.com", result: "pass", scope: "mfrom" },
    ]);

    const second = report.records[1];
    expect(second.row.sourceIp).toBe("198.51.100.25");
    expect(second.row.count).toBe(2);
    expect(second.row.policyEvaluated.disposition).toBe("quarantine");
    expect(second.row.policyEvaluated.reasons).toEqual([
      { type: "other", comment: "Unauthorized relay attempt" },
    ]);
  });

  it("parses Yahoo DMARC aggregate XML with IPv6 address accurately", () => {
    const xml = fs.readFileSync(path.join(fixturesDir, "yahoo-dmarc-report.xml"), "utf-8");
    const report = parseDmarcXml(xml);

    expect(report.metadata.orgName).toBe("Yahoo! Inc.");
    expect(report.metadata.reportId).toBe("yahoo.dmarc.20230101.001");
    expect(report.policyPublished.p).toBe("reject");

    expect(report.records).toHaveLength(1);
    expect(report.records[0].row.sourceIp).toBe("2001:db8:85a3::8a2e:370:7334");
    expect(report.records[0].row.count).toBe(42);
    expect(report.records[0].identifiers.envelopeFrom).toBe("mailer.example.com");
  });

  it("parses RFC 9990 compliant XML with strict alignment and np policy", () => {
    const xml = fs.readFileSync(path.join(fixturesDir, "rfc9990-sample.xml"), "utf-8");
    const report = parseDmarcXml(xml);

    expect(report.version).toBe("2.0");
    expect(report.metadata.reportId).toBe("urn:uuid:7c0e62a0-4ff6-11eb-ae93-0242ac130002");
    expect(report.policyPublished.adkim).toBe("s");
    expect(report.policyPublished.aspf).toBe("s");
    expect(report.policyPublished.np).toBe("reject");
  });

  it("strictly rejects DOCTYPE or ENTITY definitions to prevent XXE attacks", () => {
    const maliciousXml = `<?xml version="1.0"?>
    <!DOCTYPE feedback [
      <!ENTITY xxe SYSTEM "file:///etc/passwd">
    ]>
    <feedback>
      <report_metadata>
        <org_name>&xxe;</org_name>
        <report_id>1</report_id>
        <date_range><begin>0</begin><end>0</end></date_range>
      </report_metadata>
      <policy_published><domain>test.com</domain><p>none</p></policy_published>
    </feedback>`;

    expect(() => parseDmarcXml(maliciousXml)).toThrow(DmarcSecurityError);
  });

  it("throws DmarcParseError on empty or invalid XML", () => {
    expect(() => parseDmarcXml("")).toThrow(DmarcParseError);
    expect(() => parseDmarcXml("<not-feedback></not-feedback>")).toThrow(DmarcParseError);
  });
});
