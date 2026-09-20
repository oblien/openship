import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  invitationClaimPath,
  invitationEmailMatches,
  invitationLoginHref,
  invitationRegisterHref,
} from "./invitation-flow";

describe("invitation auth continuation", () => {
  it("builds the one canonical claim path and preserves it through auth", () => {
    expect(invitationClaimPath("inv_A-b_1")).toBe("/accept-invite/inv_A-b_1");
    expect(invitationLoginHref("inv_A-b_1")).toBe(
      "/login?returnTo=%2Faccept-invite%2Finv_A-b_1",
    );
    expect(invitationRegisterHref("inv_A-b_1")).toBe(
      "/register?returnTo=%2Faccept-invite%2Finv_A-b_1",
    );
  });

  it("matches invitation mailboxes case-insensitively", () => {
    expect(invitationEmailMatches(" New.User@Example.com ", "new.user@example.COM")).toBe(true);
    expect(invitationEmailMatches("other@example.com", "new.user@example.com")).toBe(false);
    expect(invitationEmailMatches(undefined, "new.user@example.com")).toBe(false);
  });

  it("keeps the claim page on the public preview contract", () => {
    const source = readFileSync(
      new URL("../app/accept-invite/[id]/page.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain("auth/invitation-preview/");
    expect(source).not.toContain("getInvitation(");
    expect(source).not.toContain("/auth/signin");
  });
});
