import { describe, it, expect } from "vitest";
import { normalizeAliasStrict, normalizeServiceLabel } from "./service-routing";

describe("normalizeAliasStrict — user-chosen east-west alias", () => {
  it("lowercases and keeps DNS-safe chars", () => {
    expect(normalizeAliasStrict("MyDB")).toBe("mydb");
    expect(normalizeAliasStrict("api-gateway")).toBe("api-gateway");
  });

  it("collapses runs of illegal chars to a single dash and trims edges", () => {
    expect(normalizeAliasStrict("  my db!! ")).toBe("my-db");
    expect(normalizeAliasStrict("__api__")).toBe("api");
  });

  it("returns null for empty / whitespace / all-symbol input (rejected, not 'service')", () => {
    // The lenient normalizeServiceLabel falls back to "service"; the strict one
    // must reject so a garbage entry never becomes a misleading hostname.
    expect(normalizeAliasStrict("")).toBeNull();
    expect(normalizeAliasStrict("   ")).toBeNull();
    expect(normalizeAliasStrict("!!!")).toBeNull();
    expect(normalizeAliasStrict(null)).toBeNull();
    expect(normalizeAliasStrict(undefined)).toBeNull();
    expect(normalizeServiceLabel("!!!")).toBe("service");
  });

  it("caps at a legal DNS label length (48)", () => {
    const long = "a".repeat(80);
    const out = normalizeAliasStrict(long);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(48);
  });
});
