import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  env: {
    CLOUD_MODE: true,
    CONTACT_TURNSTILE_SECRET: "test-secret",
    CONTACT_TURNSTILE_HOSTNAMES: "openship.io,www.openship.io",
  },
}));
vi.mock("@repo/platform/engine/config/env", () => ({ env: state.env }));
import { verifyContactChallenge } from "../../../src/modules/cloud-support/contact-challenge";
import { publicContactOrigin } from "../../../src/modules/cloud-support/contact-origin";
const request = vi.fn();
beforeEach(() => {
  state.env.CONTACT_TURNSTILE_SECRET = "test-secret";
  request.mockReset();
  vi.stubGlobal("fetch", request);
});
afterEach(() => vi.unstubAllGlobals());
describe("public contact bot challenge", () => {
  it("validates through Siteverify with the trusted transport IP", async () => {
    request.mockResolvedValue(
      Response.json({ success: true, hostname: "openship.io", action: "contact" }),
    );
    await verifyContactChallenge("token", "192.0.2.1");
    expect(request).toHaveBeenCalledWith(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      expect.objectContaining({ method: "POST", redirect: "error" }),
    );
    const body = request.mock.calls[0]![1].body as URLSearchParams;
    expect(Object.fromEntries(body)).toEqual({
      secret: "test-secret",
      response: "token",
      remoteip: "192.0.2.1",
    });
  });
  it.each([
    { success: false },
    { success: true, hostname: "attacker.example", action: "contact" },
    { success: true, hostname: "openship.io", action: "login" },
    null,
    [],
  ])("fails closed on an invalid provider result: %j", async (body) => {
    request.mockResolvedValue(Response.json(body));
    await expect(verifyContactChallenge("token")).rejects.toMatchObject({
      statusCode: expect.any(Number),
    });
  });
  it("fails closed when configuration is absent or the provider fails", async () => {
    state.env.CONTACT_TURNSTILE_SECRET = "";
    await expect(verifyContactChallenge("token")).rejects.toMatchObject({ statusCode: 503 });
    expect(request).not.toHaveBeenCalled();
    state.env.CONTACT_TURNSTILE_SECRET = "test-secret";
    request.mockRejectedValue(new Error("network unavailable"));
    await expect(verifyContactChallenge("token")).rejects.toMatchObject({ statusCode: 503 });
  });
  it("allows website contact without granting website origins access to authenticated API routes", () => {
    expect(publicContactOrigin("/api/cloud/support", "https://openship.io")).toBe(true);
    for (const path of [
      "/api/cloud/support/mine",
      "/api/cloud/support/tickets",
      "/api/cloud/support/blocks",
      "/api/system/settings",
    ])
      expect(publicContactOrigin(path, "https://openship.io")).toBe(false);
    expect(publicContactOrigin("/api/cloud/support", "https://openship.io.attacker.example")).toBe(
      false,
    );
    expect(publicContactOrigin("/api/cloud/support", "http://openship.io")).toBe(false);
  });
});
