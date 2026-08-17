import { afterEach, describe, expect, it, vi } from "vitest";

const env = { CLOUD_MODE: false };
vi.mock("../../src/config/env", () => ({ env }));

describe("resolveInvitationMailSource", () => {
  afterEach(() => {
    env.CLOUD_MODE = false;
  });

  it("ignores a stored cloud source on operator", async () => {
    env.CLOUD_MODE = false;
    const { resolveInvitationMailSource } = await import("../../src/lib/invitation-mail-source");
    expect(resolveInvitationMailSource("cloud")).toBe("platform");
    expect(resolveInvitationMailSource("platform")).toBe("platform");
    expect(resolveInvitationMailSource(null)).toBe("platform");
  });

});
