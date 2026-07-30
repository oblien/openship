import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContainerRegistry } from "@repo/db";
import { verifyRegistryConnection } from "./registry.service";

const registry = {
  id: "registry-a",
  organizationId: "org-a",
  registryUrl: "registry.example.com",
  repositoryPrefix: null,
  username: "robot",
  credentialsEnc: "write-only-secret",
  insecure: false,
} as ContainerRegistry;

afterEach(() => vi.unstubAllGlobals());

describe("registry connection verification", () => {
  it("exchanges a standard bearer challenge without returning or logging the token", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 401,
        headers: { "www-authenticate": 'Bearer realm="https://auth.example.com/token",service="registry.example.com"' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "short-lived-token" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await expect(verifyRegistryConnection(registry)).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://registry.example.com/v2/");
    expect(fetch.mock.calls[1]?.[0]).toBeInstanceOf(URL);
    expect((fetch.mock.calls[1]?.[0] as URL).searchParams.get("service")).toBe("registry.example.com");
    expect(fetch.mock.calls[2]?.[1]?.headers).toEqual({ Authorization: "Bearer short-lived-token" });
  });

  it("rejects incomplete credential pairs before any registry request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(verifyRegistryConnection({ ...registry, username: null })).rejects.toMatchObject({
      code: "REGISTRY_CREDENTIALS_INCOMPLETE",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
