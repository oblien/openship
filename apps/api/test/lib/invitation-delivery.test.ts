import { describe, expect, it } from "vitest";
import {
  INVITATION_DELIVERY_HEADER,
  INVITATION_DELIVERY_LINK_ONLY,
} from "@repo/core";
import { invitationNeedsEmail } from "@repo/platform/engine/lib/invitation-delivery";

describe("invitationNeedsEmail", () => {
  it("delivers normally when no explicit mode was requested", () => {
    expect(invitationNeedsEmail()).toBe(true);
    expect(invitationNeedsEmail(new Request("https://api.example/invite"))).toBe(true);
  });

  it("skips transport only for the shared link-only protocol value", () => {
    const request = new Request("https://api.example/invite", {
      headers: {
        [INVITATION_DELIVERY_HEADER]: INVITATION_DELIVERY_LINK_ONLY,
      },
    });
    expect(invitationNeedsEmail(request)).toBe(false);
  });

  it("fails open to delivery for unknown values instead of silently dropping mail", () => {
    const request = new Request("https://api.example/invite", {
      headers: { [INVITATION_DELIVERY_HEADER]: "email-ish" },
    });
    expect(invitationNeedsEmail(request)).toBe(true);
  });
});
