import { describe, expect, it } from "vitest";

import { formatPrivateKeyForOpenSsh } from "./remote-transfer";

describe("formatPrivateKeyForOpenSsh", () => {
  const key = [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "b3BlbnNzaC1rZXktdjEAAAAA",
    "-----END OPENSSH PRIVATE KEY-----",
  ].join("\n");

  it("restores the final LF OpenSSH requires when a stored key lacks one", () => {
    expect(formatPrivateKeyForOpenSsh(key)).toBe(`${key}\n`);
  });

  it("normalizes pasted Windows line endings without adding another final LF", () => {
    expect(formatPrivateKeyForOpenSsh(`\uFEFF${key.replace(/\n/g, "\r\n")}\r\n`)).toBe(`${key}\n`);
  });
});
