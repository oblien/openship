import { describe, expect, it, vi } from "vitest";
const { domains } = vi.hoisted(() => ({ domains: vi.fn() }));
vi.mock("@repo/db", () => ({ repos: { domain: { listByProject: domains } } }));
import { assertDomainProxyTarget } from "@repo/platform/engine/lib/domain-proxy-capabilities";

describe("domain body caps cannot silently move to an unsupported target", () => {
  it.each(["cloud", "cluster"])(
    "requires clearing a saved override before deploying to %s",
    async (target) => {
      domains.mockResolvedValue([
        { hostname: "events.example.com", proxy: { clientMaxBodySize: "0" } },
      ]);
      await expect(assertDomainProxyTarget({ id: "project" }, target)).rejects.toMatchObject({
        code: "DOMAIN_PROXY_SETTINGS_UNSUPPORTED",
      });
      domains.mockResolvedValue([{ hostname: "events.example.com", proxy: null }]);
      await expect(assertDomainProxyTarget({ id: "project" }, target)).resolves.toBeUndefined();
    },
  );
  it.each(["local", "server", undefined])(
    "preserves self-hosted admission for %s",
    async (target) => {
      domains.mockResolvedValue([{ proxy: { clientMaxBodySize: "1m" } }]);
      await expect(assertDomainProxyTarget({ id: "project" }, target)).resolves.toBeUndefined();
    },
  );
});
