import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  INVITATION_DELIVERY_HEADER,
  INVITATION_DELIVERY_LINK_ONLY,
} from "@repo/core";

const h = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("./client", () => ({ api: { post: h.post } }));

import { permissionsApi } from "./permissions";

beforeEach(() => h.post.mockReset());

const invite = {
  email: "new@example.com",
  role: "restricted",
  grants: [],
};

describe("permissionsApi invitation delivery mode", () => {
  it("does not add a delivery override to normal email invitations", () => {
    permissionsApi.inviteWithGrants(invite);
    expect(h.post).toHaveBeenCalledWith(
      expect.any(String),
      invite,
      undefined,
    );
  });

  it("uses the shared link-only header for restricted invitations too", () => {
    permissionsApi.inviteWithGrants(invite, { linkOnly: true });
    expect(h.post).toHaveBeenCalledWith(
      expect.any(String),
      invite,
      {
        headers: {
          [INVITATION_DELIVERY_HEADER]: INVITATION_DELIVERY_LINK_ONLY,
        },
      },
    );
  });
});
