import { Hono } from "hono";
import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  accept: vi.fn(),
  activate: vi.fn(),
  context: { principalKind: undefined as string | undefined, sessionKind: "cookie" },
}));
vi.mock("@repo/db", () => ({
  db: {},
  eq: vi.fn(),
  and: vi.fn(),
  schema: {},
  repos: {
    invitation: {
      findById: async () => ({
        id: "inv_1",
        organizationId: "org_team",
        email: "member@example.test",
        status: "accepted",
      }),
    },
  },
}));
vi.mock("@repo/platform/engine/lib/auth", () => ({
  auth: { api: { setActiveOrganization: h.activate } },
}));
vi.mock("@repo/platform/engine/lib/platform", () => ({
  getPlatformKernel: () => ({ permissions: { acceptInvitation: h.accept } }),
}));
vi.mock("@repo/platform/engine/lib/authorization", () => ({ authorization: {} }));
vi.mock("@repo/platform", () => ({ freezeContext: (value: unknown) => value }));
vi.mock("@/lib/operation-context", () => ({
  operationContext: () => h.context,
  operationData: (_: unknown, result: unknown) => result,
}));
import { acceptInvitation } from "@/modules/auth/organization.controller";

beforeEach(() => {
  vi.clearAllMocks();
  h.context.principalKind = undefined;
  h.context.sessionKind = "cookie";
  h.accept.mockResolvedValue({
    organizationId: "org_team",
    member: { id: "member_1" },
    materialized: 1,
  });
  const headers = new Headers();
  headers.append("Set-Cookie", "openship.session_data=updated-scope; Path=/; HttpOnly; Secure");
  headers.append("Set-Cookie", "openship.active_organization=org_team; Path=/; HttpOnly; Secure");
  h.activate.mockResolvedValue({ headers, response: {} });
});
const request = () =>
  new Hono().post("/accept", acceptInvitation).request("/accept", {
    method: "POST",
    body: JSON.stringify({ invitationId: "inv_1" }),
    headers: {
      "content-type": "application/json",
      cookie: "openship.session_token=recipient-session",
    },
  });

it("returns the updated Better Auth cookies after selecting the invitation's organization", async () => {
  const response = await request();
  expect(response.status).toBe(200);
  expect(response.headers.getSetCookie()).toEqual([
    "openship.session_data=updated-scope; Path=/; HttpOnly; Secure",
    "openship.active_organization=org_team; Path=/; HttpOnly; Secure",
  ]);
  expect(h.activate).toHaveBeenCalledWith({
    body: { organizationId: "org_team" },
    returnHeaders: true,
    headers: expect.any(Headers),
  });
  expect(await response.json()).toMatchObject({
    invitation: { organizationId: "org_team" },
    member: { id: "member_1" },
  });
});

it.each(["zero-auth", "principal"])(
  "does not turn a %s operation into a cookie login",
  async (kind) => {
    if (kind === "principal") h.context.principalKind = "token";
    else h.context.sessionKind = "zero-auth";
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(h.activate).not.toHaveBeenCalled();
  },
);
