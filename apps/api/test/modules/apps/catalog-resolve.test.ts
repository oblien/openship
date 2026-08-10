import { describe, it, expect } from "vitest";
import { resolveCatalog, type ResolvedAppTemplate } from "../../../src/modules/apps/catalog-source";
import type { AppTemplate } from "@repo/core";

/** Minimal AppTemplate — resolveCatalog only reads id/minEngine/identity fields. */
const mk = (over: Partial<AppTemplate>): AppTemplate =>
  ({ id: "x", name: "X", description: "d", kind: "template", logo: "x", category: "other", ...over }) as AppTemplate;

describe("resolveCatalog — engine gate + bundled fallback", () => {
  it("passes through an entry this engine supports", () => {
    const e = resolveCatalog([mk({ id: "__ok", minEngine: "0.1.0", available: true })], [], "0.3.0").find(
      (x) => x.id === "__ok",
    );
    expect(e?.requiresUpdate).toBeUndefined();
    expect(e?.available).toBe(true);
  });

  it("surfaces a guided placeholder for a too-new, non-bundled app", () => {
    const e = resolveCatalog([mk({ id: "__toonew", minEngine: "999.0.0", available: true })], [], "0.3.0").find(
      (x) => x.id === "__toonew",
    );
    expect(e?.requiresUpdate?.minVersion).toBe("999.0.0");
    expect(e?.available).toBe(false);
    expect(e?.services).toBeUndefined(); // a lightweight stub, not the real template
  });

  it("falls back to the bundled copy when a too-new overlay overrides a bundled app", () => {
    // `mongodb` is bundled + engine-ok (no minEngine). A too-new overlay override
    // must NOT gate it — serve the bundled copy, flagged updateAvailable.
    const e = resolveCatalog([mk({ id: "mongodb", minEngine: "999.0.0" })], [], "0.3.0").find(
      (x) => x.id === "mongodb",
    );
    expect(e?.requiresUpdate).toBeUndefined();
    expect(e?.updateAvailable).toBe(true);
    expect((e?.services?.length ?? 0)).toBeGreaterThan(0); // the real bundled template
  });

  it("passes through schema-too-new identity placeholders for brand-new ids", () => {
    const ph = {
      ...mk({ id: "__shape" }),
      available: false,
      requiresUpdate: { minVersion: "2.0.0" },
    } as ResolvedAppTemplate;
    const e = resolveCatalog([], [ph], "0.3.0").find((x) => x.id === "__shape");
    expect(e?.requiresUpdate?.minVersion).toBe("2.0.0");
  });
});
