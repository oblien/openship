import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  find: vi.fn(),
  manage: vi.fn(),
  rows: [] as Array<{ id: string; projectId: string; hostname: string }>,
}));
vi.mock("@repo/db", () => ({ repos: { domain: { findDueCloudSslChecks: h.find } } }));
vi.mock("@repo/platform/engine/lib/domain-ssl", () => ({ manageDomainSsl: h.manage }));
vi.mock("@repo/platform/engine/lib/project-runtime-lock", () => ({
  withProjectStateLock: async (_id: string, work: () => Promise<unknown>) => work(),
  withLiveProjectRuntimeMutation: (id: string, work: (project: { id: string }) => Promise<void>) =>
    work({ id }),
}));
import { checkCloudDomainHttps } from "@repo/platform/engine/modules/domains/cloud-ssl-health";

beforeEach(() => {
  h.rows = Array.from({ length: 4 }, (_, i) => ({
    id: "d" + i,
    projectId: "p" + i,
    hostname: "site" + i + ".example.com",
  }));
  h.find
    .mockReset()
    .mockImplementation(async (_cutoff, _limit, id) =>
      id ? h.rows.filter((row) => row.id === id) : h.rows,
    );
  h.manage.mockReset().mockResolvedValue({ verified: true });
});
describe("scheduled Cloud HTTPS observation", () => {
  it("only verifies, respects the concurrency budget and reports unknown separately", async () => {
    let active = 0;
    let peak = 0;
    h.manage.mockImplementation(async (host) => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return host.startsWith("site0")
        ? { verified: false, reason: "edge_invalid" }
        : host.startsWith("site1")
          ? { verified: false, reason: "read_error" }
          : { verified: true };
    });
    expect(await checkCloudDomainHttps()).toEqual({
      checked: 4,
      healthy: 2,
      invalid: 1,
      unknown: 1,
    });
    expect(peak).toBeLessThanOrEqual(3);
    for (const [host, options] of h.manage.mock.calls) {
      expect(options).toEqual({
        action: "verify",
        projectId: h.rows.find((row) => row.hostname === host)!.projectId,
      });
    }
  });
  it("rechecks eligibility after taking the project lock", async () => {
    h.find.mockImplementation(async (_cutoff, _limit, id) => (id ? [] : h.rows));
    expect(await checkCloudDomainHttps()).toMatchObject({ checked: 0 });
    expect(h.manage).not.toHaveBeenCalled();
  });
  it("does not stop other domains when one provider is unreachable", async () => {
    h.manage.mockRejectedValueOnce(new Error("Provider unreachable"));
    expect(await checkCloudDomainHttps()).toEqual({
      checked: 3,
      healthy: 3,
      invalid: 0,
      unknown: 1,
    });
    expect(h.manage).toHaveBeenCalledTimes(4);
  });
});
