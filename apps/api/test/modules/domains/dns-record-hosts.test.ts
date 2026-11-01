import "../mail/_setup-env";
import { describe, expect, it } from "vitest";

import { relativeSubdomain, dnsRecordHosts } from "@repo/platform/engine/modules/domains/domain.service";

describe("relativeSubdomain", () => {
  it("returns null for an apex (2 labels)", () => {
    expect(relativeSubdomain("example.com")).toBeNull();
  });
  it("returns the sub-label for a subdomain", () => {
    expect(relativeSubdomain("app.example.com")).toBe("app");
  });
  it("returns the full sub-path for a deep subdomain", () => {
    expect(relativeSubdomain("a.b.example.com")).toBe("a.b");
  });
});

describe("dnsRecordHosts — host is per-hostname, name is the FQDN verify resolves", () => {
  it("apex: route host @, TXT host _openship-challenge", () => {
    const r = dnsRecordHosts("example.com");
    expect(r).toEqual({
      routeHost: "@",
      routeName: "example.com",
      txtHost: "_openship-challenge",
      txtName: "_openship-challenge.example.com",
    });
  });

  it("subdomain: route host is the sub-label, NOT @ (the bug that broke verify)", () => {
    const r = dnsRecordHosts("app.example.com");
    expect(r.routeHost).toBe("app");
    expect(r.routeName).toBe("app.example.com");
    expect(r.txtHost).toBe("_openship-challenge.app");
    expect(r.txtName).toBe("_openship-challenge.app.example.com");
  });

  it("record `name` equals exactly what verify* resolves (A/CNAME → hostname, TXT → _openship-challenge.<hostname>)", () => {
    for (const host of ["example.com", "app.example.com", "a.b.c.example.com"]) {
      const r = dnsRecordHosts(host);
      // verifyARecord/verifyCname resolve `hostname`
      expect(r.routeName).toBe(host);
      // verifyTxt resolves `_openship-challenge.${hostname}`
      expect(r.txtName).toBe(`_openship-challenge.${host}`);
    }
  });
});
