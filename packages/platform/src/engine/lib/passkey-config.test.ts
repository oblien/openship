import { describe, expect, it } from "vitest";
import { resolvePasskeyConfig } from "./passkey-config";

describe("passkey relying party", () => {
  it.each([
    ["https://app.openship.io", "app.openship.io", "https://app.openship.io"],
    ["https://ops.example.com/", "ops.example.com", "https://ops.example.com"],
    ["http://localhost:3100", "localhost", "http://localhost:3100"],
  ])("binds browser verification to %s", (url, rpID, origin) => {
    expect(resolvePasskeyConfig(url)).toMatchObject({
      rpID,
      origin,
      rpName: "Openship",
      authenticatorSelection: { residentKey: "required" },
    });
  });

  it.each(["not a URL", "file:///tmp/dashboard"])(
    "rejects an invalid declared origin: %s",
    (url) => {
      expect(() => resolvePasskeyConfig(url)).toThrow();
    },
  );
});
