import { describe, it, expect } from "vitest";
import { assertTargetNotCloud, probeTarget, TargetIsCloudError, TargetUnreachableError } from "./target-probe";

// GATE 3: a migrate-to-server must refuse a multi-tenant (cloudMode) or
// unreachable target BEFORE transferring — fail-closed.
function fakeFetch(body: unknown, ok = true): typeof fetch {
  return (async () =>
    ({ ok, json: async () => body }) as unknown as Response) as unknown as typeof fetch;
}
const throwingFetch: typeof fetch = (async () => {
  throw new Error("ECONNREFUSED");
}) as unknown as typeof fetch;

describe("GATE 3 target probe", () => {
  it("accepts a reachable self-hosted target", async () => {
    const p = await assertTargetNotCloud("https://ops.example.com", {
      fetchImpl: fakeFetch({ status: "ok", cloudMode: false }),
    });
    expect(p.cloudMode).toBe(false);
  });

  it("refuses a multi-tenant cloud target", async () => {
    await expect(
      assertTargetNotCloud("https://api.openship.io", { fetchImpl: fakeFetch({ status: "ok", cloudMode: true }) }),
    ).rejects.toBeInstanceOf(TargetIsCloudError);
  });

  it("refuses (fail-closed) when the target is unreachable", async () => {
    await expect(
      assertTargetNotCloud("https://down.example.com", { fetchImpl: throwingFetch }),
    ).rejects.toBeInstanceOf(TargetUnreachableError);
  });

  it("treats a missing cloudMode field as not-cloud (reachable ok)", async () => {
    const p = await probeTarget("https://legacy.example.com", { fetchImpl: fakeFetch({ status: "ok" }) });
    expect(p).toMatchObject({ reachable: true, cloudMode: false });
  });
});
