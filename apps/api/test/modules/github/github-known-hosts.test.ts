import { describe, it, expect } from "vitest";
import { GITHUB_KNOWN_HOSTS } from "@repo/platform/engine/modules/github/github-known-hosts";

describe("GITHUB_KNOWN_HOSTS", () => {
  const lines = GITHUB_KNOWN_HOSTS.split("\n").filter((l) => l.trim().length > 0);

  it("pins all three published github.com host-key types", () => {
    expect(GITHUB_KNOWN_HOSTS).toContain("ssh-ed25519");
    expect(GITHUB_KNOWN_HOSTS).toContain("ecdsa-sha2-nistp256");
    expect(GITHUB_KNOWN_HOSTS).toContain("ssh-rsa");
  });

  it("scopes every entry to github.com", () => {
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) expect(line.startsWith("github.com ")).toBe(true);
  });

  it("ends with a trailing newline (valid known_hosts file)", () => {
    expect(GITHUB_KNOWN_HOSTS.endsWith("\n")).toBe(true);
  });

  it("carries a base64 key body on every line", () => {
    for (const line of lines) {
      const [, , key] = line.split(" ");
      expect(key).toBeTruthy();
      expect(key.length).toBeGreaterThan(20);
    }
  });
});
