import { describe, it, expect } from "vitest";
import { mergeAdvanced } from "../../../src/modules/services/service.service";

/**
 * `service.advanced` is one JSONB blob holding four independently-owned keys:
 *   healthcheck — the Docker HEALTHCHECK, edited in the service settings form
 *   readiness   — the deploy gate, which decides whether a deploy CAN fail
 *   files       — generated config files, written by an app template at install
 *   resources   — per-service cpu/memory caps
 *
 * It used to be written straight through, i.e. replaced. Any caller that mentioned
 * one key silently dropped the rest — and `PATCH /projects/:id/services/:sid` is
 * MCP-exposed, so an agent setting a healthcheck would erase the readiness gate
 * (changing whether deploys can fail) and an app template's config files.
 *
 * These pin the merge that replaced it. Omitted = untouched, null = removed.
 */
describe("mergeAdvanced", () => {
  const stored = {
    healthcheck: { test: "pg_isready" },
    readiness: { enabled: true, onFailure: "fail" as const },
    files: [{ path: "/etc/kong.yml", content: "services: []" }],
    resources: { memoryMb: 512 },
  };

  it("preserves every key a partial patch doesn't mention", () => {
    const next = mergeAdvanced(stored, { healthcheck: { test: "curl -f localhost" } });
    expect(next.healthcheck).toEqual({ test: "curl -f localhost" });
    // The three the caller said nothing about survive.
    expect(next.readiness).toEqual(stored.readiness);
    expect(next.files).toEqual(stored.files);
    expect(next.resources).toEqual(stored.resources);
  });

  // The regression that motivated this: the readiness gate controls whether a
  // failed check vetoes a deploy, so losing it silently changes deploy behaviour.
  it("does not drop the readiness gate when only a healthcheck is sent", () => {
    const next = mergeAdvanced(stored, { healthcheck: { test: "x" } });
    expect(next.readiness).toBeDefined();
    expect(next.readiness?.onFailure).toBe("fail");
  });

  it("does not drop an app template's files when only readiness is sent", () => {
    const next = mergeAdvanced(stored, { readiness: { stabilization: true } });
    expect(next.files).toEqual(stored.files);
    expect(next.readiness).toEqual({ stabilization: true });
  });

  it("removes a key sent as null, leaving the others", () => {
    const next = mergeAdvanced(stored, { healthcheck: null });
    expect("healthcheck" in next).toBe(false);
    expect(next.readiness).toEqual(stored.readiness);
    expect(next.files).toEqual(stored.files);
  });

  it("can remove and set in one patch", () => {
    const next = mergeAdvanced(stored, {
      healthcheck: null,
      readiness: { enabled: true, onFailure: "warn" },
    });
    expect("healthcheck" in next).toBe(false);
    expect(next.readiness).toEqual({ enabled: true, onFailure: "warn" });
  });

  it("REPLACES a key rather than deep-merging it", () => {
    // A partially-specified healthcheck must not inherit the stored interval —
    // that would resurrect a field the user deleted.
    const next = mergeAdvanced(
      { healthcheck: { test: "old", interval: "30s", retries: 5 } },
      { healthcheck: { test: "new" } },
    );
    expect(next.healthcheck).toEqual({ test: "new" });
  });

  it("treats an explicit null blob as a full clear (the one way to reset it)", () => {
    expect(mergeAdvanced(stored, null)).toEqual({});
  });

  it("returns the stored blob untouched when nothing is sent", () => {
    expect(mergeAdvanced(stored, undefined)).toEqual(stored);
  });

  it("starts from empty on create (no stored blob) and strips null sentinels", () => {
    expect(mergeAdvanced(null, { healthcheck: { test: "x" }, readiness: null })).toEqual({
      healthcheck: { test: "x" },
    });
    expect(mergeAdvanced(null, undefined)).toEqual({});
  });

  it("ignores a non-object patch rather than storing garbage", () => {
    expect(mergeAdvanced(stored, "nope")).toEqual({});
    expect(mergeAdvanced(stored, [1, 2])).toEqual({});
  });

  it("does not mutate the stored blob it was handed", () => {
    const original = { healthcheck: { test: "pg_isready" }, readiness: { enabled: true } };
    const snapshot = JSON.parse(JSON.stringify(original));
    mergeAdvanced(original, { healthcheck: null, readiness: { enabled: false } });
    expect(original).toEqual(snapshot);
  });
});
