/**
 * Pure-function tests for the Azure credential helpers. No DB, no network —
 * these cover the security-relevant seams (auth header shape, org derivation
 * from the request target).
 */

import { describe, expect, it } from "vitest";
import { adoOrgFromUrl, authHeader } from "./azure-url";

describe("authHeader", () => {
  it("encodes the PAT as the Basic password with a dummy username", () => {
    const header = authHeader("azurepat");
    expect(header).toMatch(/^Basic /);
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    expect(decoded).toBe("pat:azurepat");
  });

  it("never leaves the token readable in the header value itself", () => {
    const header = authHeader("super-secret-pat");
    expect(header).not.toContain("super-secret-pat");
  });
});

describe("adoOrgFromUrl", () => {
  it("reads the org from dev.azure.com URLs", () => {
    expect(adoOrgFromUrl("https://dev.azure.com/contoso/project/_git/repo")).toBe("contoso");
  });

  it("reads the org from the visualstudio.com host", () => {
    expect(adoOrgFromUrl("https://contoso.visualstudio.com/project/_git/repo")).toBe("contoso");
  });

  it("does not misread non-REST subdomains like ssh.dev.azure.com", () => {
    // First path segment there is "v3", not an organization.
    expect(adoOrgFromUrl("https://ssh.dev.azure.com/v3/contoso/project/repo")).toBeNull();
  });

  it("returns null for non-Azure hosts", () => {
    expect(adoOrgFromUrl("https://github.com/owner/repo")).toBeNull();
  });

  it("returns null for garbage input", () => {
    expect(adoOrgFromUrl("not a url")).toBeNull();
  });
});
