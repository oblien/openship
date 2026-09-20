import { describe, expect, it } from "vitest";

import { registerConnectivityCheck, runConnectivityCheck } from "@repo/platform/engine/lib/connectivity";

describe("connectivity registry", () => {
  it("returns misconfigured for an unknown kind (never throws)", async () => {
    const r = await runConnectivityCheck("does-not-exist", {});
    expect(r).toMatchObject({ ok: false, code: "misconfigured" });
  });

  it("dispatches to a registered check", async () => {
    registerConnectivityCheck<{ n: number }>("test:ok", async (input) => ({
      ok: true,
      code: "reachable",
      message: `n=${input.n}`,
    }));
    const r = await runConnectivityCheck("test:ok", { n: 7 });
    expect(r).toMatchObject({ ok: true, code: "reachable", message: "n=7" });
  });

  it("classifies a thrown error rather than propagating it", async () => {
    registerConnectivityCheck("test:throw", async () => {
      throw new Error("connect ECONNREFUSED 1.2.3.4:22");
    });
    const r = await runConnectivityCheck("test:throw", null);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("unreachable");
  });
});
