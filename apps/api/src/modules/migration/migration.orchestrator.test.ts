import { describe, it, expect } from "vitest";
import {
  resolveScannedContainerId,
  planResumeTransfer,
  describeCutoverRemainder,
  type PendingItem,
} from "./migration.orchestrator";

describe("resolveScannedContainerId", () => {
  it("returns the scanned container id for a service that was discovered", () => {
    expect(resolveScannedContainerId("postgres", { postgres: "abc123" })).toBe("abc123");
  });

  it("returns null when the service was never scanned — never a stale guess", () => {
    expect(resolveScannedContainerId("redis", { postgres: "abc123" })).toBeNull();
  });

  it("returns null for an empty scan map", () => {
    expect(resolveScannedContainerId("postgres", {})).toBeNull();
  });
});

describe("planResumeTransfer", () => {
  const pendingVolume = (over: Partial<PendingItem> = {}): PendingItem => ({
    key: "volume:openship-chatwoot-postgres-data",
    kind: "volume",
    source: "openship-chatwoot-postgres-data",
    reason: "error",
    ...over,
  });

  it("uses the operator's override, not the stale pre-override source, for a volume item", () => {
    // Regression: a previous version computed `src` from the override but then
    // called transferVolume(item.source, …) — the STALE name — so a manual
    // fix for a "no such volume" pending item was silently ignored on resume.
    const item = pendingVolume();
    const plan = planResumeTransfer(item, { [item.key]: "chatwoot-postgres-data" });
    expect(plan).toEqual({ kind: "volume", source: "chatwoot-postgres-data" });
  });

  it("falls back to the pending item's own source when no override is given", () => {
    const item = pendingVolume();
    expect(planResumeTransfer(item, {})).toEqual({
      kind: "volume",
      source: item.source,
    });
  });

  it("ignores an override keyed to a DIFFERENT item", () => {
    const item = pendingVolume();
    const plan = planResumeTransfer(item, { "volume:something-else": "nope" });
    expect(plan).toEqual({ kind: "volume", source: item.source });
  });

  it("bind item with no override: reads and writes the same (original) path", () => {
    const item: PendingItem = {
      key: "bind:/opt/app/data",
      kind: "bind",
      source: "/opt/app/data",
      reason: "error",
    };
    expect(planResumeTransfer(item, {})).toEqual({
      kind: "bind",
      asPath: false,
      source: "/opt/app/data",
    });
  });

  it("bind item WITH an override: reads from the new path, writes to the ORIGINAL bind path", () => {
    // A bind override reads from a replacement source but the target container
    // still mounts the original path — so the destination must stay unchanged.
    const item: PendingItem = {
      key: "bind:/opt/app/data",
      kind: "bind",
      source: "/opt/app/data",
      reason: "missing",
    };
    const plan = planResumeTransfer(item, { [item.key]: "/mnt/backup/data" });
    expect(plan).toEqual({
      kind: "bind",
      asPath: true,
      source: "/mnt/backup/data",
      dest: "/opt/app/data",
    });
  });

  it("path item: uses the item's own dest when set", () => {
    const item: PendingItem = {
      key: "path:/src",
      kind: "path",
      source: "/src",
      dest: "/dst",
      reason: "error",
    };
    expect(planResumeTransfer(item, {})).toEqual({
      kind: "path",
      source: "/src",
      dest: "/dst",
    });
  });

  it("path item: falls back to source as dest when the item has none", () => {
    const item: PendingItem = {
      key: "path:/src",
      kind: "path",
      source: "/src",
      reason: "error",
    };
    expect(planResumeTransfer(item, {})).toEqual({
      kind: "path",
      source: "/src",
      dest: "/src",
    });
  });
});

/**
 * Cutover is NOT atomic and cannot be — there is no transaction across two Docker daemons,
 * and by then the target is already serving. What it must be is honest, which is what this
 * pins: the bug it replaces caught every destroy error and dropped it, then reported
 * `succeeded`, so a container still standing on the old server (holding its ports, or
 * brought back by a restart policy) was invisible.
 */
describe("describeCutoverRemainder", () => {
  const c = (name: string, id: string, reason = "device or resource busy") => ({
    name,
    containerId: id,
    reason,
  });

  it("returns null when everything was removed", () => {
    // The caller logs a plain success off this — never "0 containers could not be removed".
    expect(describeCutoverRemainder([])).toBeNull();
  });

  it("names every container that survived, and why", () => {
    // "Some containers could not be removed" would leave the operator hunting on a host they
    // were just told to stop thinking about.
    const msg = describeCutoverRemainder([c("web", "abcdef1234567890"), c("api", "0123456789abcdef")]);
    expect(msg).toContain("web (abcdef123456");
    expect(msg).toContain("api (0123456789ab");
    expect(msg).toContain("device or resource busy");
  });

  it("counts them and says what to do", () => {
    const msg = describeCutoverRemainder([c("web", "abcdef1234567890")]);
    expect(msg).toContain("1 source container(s)");
    expect(msg).toMatch(/by hand on the old server/);
  });

  it("shortens the container id to the docker-style prefix", () => {
    // A full 64-hex id in a log line buries the reason after it.
    const msg = describeCutoverRemainder([c("web", "a".repeat(64))])!;
    expect(msg).toContain("a".repeat(12));
    expect(msg).not.toContain("a".repeat(13));
  });

  it("carries each container's OWN reason rather than one summary", () => {
    const msg = describeCutoverRemainder([
      c("web", "aaaaaaaaaaaa1111", "in use by network"),
      c("db", "bbbbbbbbbbbb2222", "permission denied"),
    ])!;
    expect(msg).toContain("in use by network");
    expect(msg).toContain("permission denied");
  });
});
