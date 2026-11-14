import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * URL construction for the discovery API. Service keys are stable discovery
 * identities (`id:my-app`, `compose:proj/serv`) that travel in the URL path —
 * the slash inside a Compose identity MUST be percent-encoded or the router
 * matches it as a path separator and the request 404s. Hono decodes the
 * segment server-side (`c.req.param` applies decodeURIComponent).
 */
const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

vi.mock("./client", () => ({ api }));

import { discoveryApi } from "./discovery";

describe("discoveryApi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads status from the server-scoped discovery resource", () => {
    discoveryApi.status("srv_1");
    expect(api.get).toHaveBeenCalledWith("discovery/servers/srv_1/discovery", undefined);
  });

  it("encodes BOTH separators of a Compose service key in the path", () => {
    discoveryApi.suppress("srv_1", "compose:proj/serv");
    expect(api.post).toHaveBeenCalledWith(
      "discovery/servers/srv_1/discovery/services/compose%3Aproj%2Fserv/suppress",
    );
    discoveryApi.unsuppress("srv_1", "compose:proj/serv");
    expect(api.post).toHaveBeenCalledWith(
      "discovery/servers/srv_1/discovery/services/compose%3Aproj%2Fserv/unsuppress",
    );
    discoveryApi.forget("srv_1", "compose:proj/serv");
    expect(api.delete).toHaveBeenCalledWith(
      "discovery/servers/srv_1/discovery/services/compose%3Aproj%2Fserv",
    );
  });

  it("keeps a plain id: key intact while still encoding it defensively", () => {
    discoveryApi.suppress("srv_1", "id:my-app");
    expect(api.post).toHaveBeenCalledWith(
      "discovery/servers/srv_1/discovery/services/id%3Amy-app/suppress",
    );
  });

  it("lets rescan run far longer than the default timeout and never dedupes", () => {
    discoveryApi.rescan("srv_1");
    expect(api.post).toHaveBeenCalledWith(
      "discovery/servers/srv_1/discovery/rescan",
      undefined,
      { timeout: 180_000, dedupe: false },
    );
  });

  it("sends the enable/disable toggle as the JSON body of the PUT", () => {
    discoveryApi.configure("srv_1", { enabled: false });
    expect(api.put).toHaveBeenCalledWith(
      "discovery/servers/srv_1/discovery",
      { enabled: false },
    );
  });
});
