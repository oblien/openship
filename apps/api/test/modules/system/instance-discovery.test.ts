import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverInstance } from "../../../src/modules/system/instance/instance-discovery";

const request = vi.fn<typeof fetch>();
const origin = "https://ops.example.test";
const identity = (address = origin) => ({
  protocol: 1,
  origin: address,
  installationId: "380edbad-d4a8-483e-a14e-f74fc1e7dab0",
});
beforeEach(() => {
  request.mockReset();
  vi.stubGlobal("fetch", request);
});
afterEach(() => vi.unstubAllGlobals());

describe("instance URL discovery", () => {
  it("connects directly to an API-only instance without sending any credentials", async () => {
    request.mockResolvedValueOnce(Response.json(identity()));
    expect(await discoverInstance(origin)).toEqual(identity());
    expect(request).toHaveBeenCalledExactlyOnceWith(`${origin}/api/system/instance/identity`, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
  });
  it.each(["not-found", "html"])(
    "finds the dashboard proxy after a %s root response",
    async (response) => {
      request.mockResolvedValueOnce(
        response === "not-found"
          ? new Response(null, { status: 404 })
          : new Response("<!doctype html><title>Openship</title>"),
      );
      request.mockResolvedValueOnce(Response.json(identity(`${origin}/api/proxy`)));
      expect(await discoverInstance(origin)).toEqual(identity(`${origin}/api/proxy`));
      expect(request.mock.calls.map(([url]) => url)).toEqual([
        `${origin}/api/system/instance/identity`,
        `${origin}/api/proxy/api/system/instance/identity`,
      ]);
    },
  );
  it("does not append a second proxy mount to an explicit API URL", async () => {
    request.mockResolvedValueOnce(Response.json(identity(`${origin}/api/proxy`)));
    await discoverInstance(`${origin}/api/proxy`);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each(["https://other.test", "http://ops.example.test", `${origin}/unrelated`])(
    "rejects a remote identity that chooses another destination: %s",
    async (address) => {
      request.mockResolvedValueOnce(Response.json(identity(address)));
      await expect(discoverInstance(origin)).rejects.toThrow("configured on the remote instance");
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it.each([301, 302, 401, 403, 503])(
    "does not follow a redirect or bypass a %s response",
    async (status) => {
      request.mockResolvedValueOnce(
        new Response(null, { status, headers: { location: "https://other.test" } }),
      );
      await expect(discoverInstance(origin)).rejects.toThrow("Could not connect");
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects TLS failures without changing the destination", async () => {
    request.mockRejectedValueOnce(new TypeError("TLS failure"));
    await expect(discoverInstance(origin)).rejects.toThrow("Could not connect");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed public identities", async () => {
    request.mockImplementation(async () =>
      Response.json({ protocol: 99, origin, installationId: "not-an-id" }),
    );
    await expect(discoverInstance(origin)).rejects.toThrow("Could not connect");
  });
  it("rejects plaintext remote origins before making a request", async () => {
    await expect(discoverInstance("http://ops.example.test")).rejects.toThrow("HTTPS");
    expect(request).not.toHaveBeenCalled();
  });
});
