import { afterEach, expect, it, vi } from "vitest";
import { SDK_CAPABILITIES } from "@repo/contracts";
import { discoverPublicInstanceApi } from "../../src/lib/public-instance-api";
afterEach(() => vi.unstubAllGlobals());

it("confines credential-free discovery to the supplied origin and refuses redirects", async () => {
  const fetcher = vi.fn(async () => Response.json({ status: "ok", sdk: SDK_CAPABILITIES }));
  vi.stubGlobal("fetch", fetcher);
  expect(await discoverPublicInstanceApi("https://ship.test/prefix/")).toBe("https://ship.test/prefix/api/proxy");
  expect(fetcher).toHaveBeenCalledWith("https://ship.test/prefix/api/proxy/api/health", expect.objectContaining({ redirect: "error", headers: { Accept: "application/json" } }));
});
it.each(["https://ship.test/api", "https://ship.test/api/proxy", "https://ship.test/prefix/api/proxy/"])("does not reinterpret an explicit API: %s", async url => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  expect(await discoverPublicInstanceApi(url)).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([{ status: "ok" }, { sdk: SDK_CAPABILITIES }, { status: "ok", sdk: { protocol: -1 } }])("ignores an unrelated health response: %j", async body => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(body)));
  expect(await discoverPublicInstanceApi("https://ship.test")).toBeNull();
});
