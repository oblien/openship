// @vitest-environment happy-dom
import { afterAll, beforeEach, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => {
  const mock = vi.fn();
  vi.stubGlobal("fetch", mock);
  return mock;
});

vi.mock("@/lib/api/urls", () => ({ getAuthBaseUrl: () => "https://api.example.test" }));
vi.mock("./error-reporting", () => ({ reportClientError: vi.fn() }));

import { authClient, submitMcpConsent } from "./auth-client";

let requests: Array<{
  url: string;
  body: Record<string, unknown>;
  credentials?: RequestCredentials;
}>;

beforeEach(() => {
  requests = [];
  window.history.replaceState(null, "", "/mcp/authorize");
  fetchMock.mockReset().mockImplementation(async (input, init) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")),
      credentials: init?.credentials,
    });
    return Response.json({ redirect: false, url: "https://client.example/callback?code=issued" });
  });
});

afterAll(() => vi.unstubAllGlobals());

it("sends an embedded connection's signed consent through the provider client", async () => {
  window.history.replaceState(null, "", "/assistant?client_id=unrelated&sig=unrelated");
  const oauth_query = "client_id=embedded-client&state=original&sig=original-signature";
  expect(await submitMcpConsent(true, oauth_query)).toBe(
    "https://client.example/callback?code=issued",
  );
  expect(requests).toEqual([
    {
      url: "https://api.example.test/api/auth/oauth2/consent",
      body: { accept: true, oauth_query },
      credentials: "include",
    },
  ]);
});

it.each([true, false])(
  "returns accepted=%s consent to the form without automatically navigating to its single-use callback",
  async (accept) => {
    const callback = accept
      ? "https://api.example.test/api/assistant/callback?code=issued&state=single-use"
      : "https://api.example.test/api/assistant/callback?error=access_denied";
    fetchMock.mockResolvedValueOnce(Response.json({ redirect: true, url: callback }));
    const navigate = vi.spyOn(window.location, "href", "set").mockImplementation(() => {});
    try {
      expect(await submitMcpConsent(accept, "client_id=embedded-client&sig=signature")).toBe(
        callback,
      );
      expect(navigate).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      navigate.mockRestore();
    }
  },
);

it("keeps automatic navigation enabled for ordinary social sign-in", async () => {
  const authorizationUrl = "https://accounts.example.test/authorize";
  fetchMock.mockResolvedValueOnce(Response.json({ redirect: true, url: authorizationUrl }));
  const navigate = vi.spyOn(window.location, "href", "set").mockImplementation(() => {});
  try {
    await authClient.signIn.social({ provider: "google", callbackURL: "/projects" });
    expect(navigate).toHaveBeenCalledExactlyOnceWith(authorizationUrl);
  } finally {
    navigate.mockRestore();
  }
});

it("lets the provider carry only signed page parameters and preserve repeated resources", async () => {
  const query = new URLSearchParams([
    ["client_id", "page-client"],
    ["resource", "https://api.example.test/api/mcp"],
    ["resource", "https://api.example.test/api/proxy/api/mcp"],
    ["sig", "signature"],
    ["ba_param", "client_id"],
    ["ba_param", "resource"],
    ["ba_param", "ba_param"],
  ]);
  window.history.replaceState(null, "", `/mcp/authorize?${query}&signedIn=1&unrelated=value`);
  await submitMcpConsent(false, null);
  expect(requests[0]?.body).toEqual({ accept: false, oauth_query: query.toString() });
});

it("keeps an ordinary sign-in free of OAuth continuation data", async () => {
  window.history.replaceState(null, "", "/login?returnTo=%2Fprojects");
  await authClient.signIn.email({ email: "owner@example.test", password: "test-password" });
  expect(requests[0]?.body).toEqual({ email: "owner@example.test", password: "test-password" });
});

it("preserves the provider's unauthorized status for the form's sign-in recovery", async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ message: "Sign in again" }, { status: 401 }));
  await expect(submitMcpConsent(true, "client_id=client&sig=signature")).rejects.toMatchObject({
    status: 401,
  });
});

it("does not resume OAuth when the consent form changes the active organization", async () => {
  window.history.replaceState(
    null,
    "",
    "/mcp/authorize?client_id=page-client&sig=signature&ba_param=client_id",
  );
  await authClient.organization.setActive({ organizationId: "other-organization" });
  expect(requests[0]?.body).toEqual({ organizationId: "other-organization" });
});
