import { describe, expect, it } from "vitest";
import { parseAllowedCloudOrigin } from "./origin";

describe("parseAllowedCloudOrigin", () => {
  it("keeps an https origin and the self-hosted proxy prefix", () => {
    expect(parseAllowedCloudOrigin("https://ops.example.com")).toBe("https://ops.example.com");
    expect(parseAllowedCloudOrigin("https://ops.example.com/api/proxy")).toBe(
      "https://ops.example.com/api/proxy",
    );
    expect(parseAllowedCloudOrigin("https://ops.example.com/api/proxy/")).toBe(
      "https://ops.example.com/api/proxy",
    );
    expect(parseAllowedCloudOrigin("https://ops.example.com/api/cloud")).toBeNull();
    expect(parseAllowedCloudOrigin("https://api.openship.io")).toBe("https://api.openship.io");
  });

  it("allows loopback http and rejects public http", () => {
    expect(parseAllowedCloudOrigin("http://127.0.0.1:4000")).toBe("http://127.0.0.1:4000");
    expect(parseAllowedCloudOrigin("http://localhost:4000/api/proxy")).toBe(
      "http://localhost:4000/api/proxy",
    );
    expect(parseAllowedCloudOrigin("http://localhost:4000/api")).toBeNull();
    expect(parseAllowedCloudOrigin("http://[::1]:4000")).toBe("http://[::1]:4000");
    expect(parseAllowedCloudOrigin("http://ops.example.com")).toBeNull();
  });

  it("rejects userinfo, empty input, and non-http schemes", () => {
    expect(parseAllowedCloudOrigin("https://user:pass@ops.example.com")).toBeNull();
    expect(parseAllowedCloudOrigin("")).toBeNull();
    expect(parseAllowedCloudOrigin("javascript:alert(1)")).toBeNull();
    expect(parseAllowedCloudOrigin(null)).toBeNull();
  });
});
