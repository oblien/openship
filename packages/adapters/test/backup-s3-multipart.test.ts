/**
 * S3's 10,000-part limit is a SIZE ceiling, and a fixed part size makes it a silent one.
 *
 * At a flat 16 MiB part size an upload larger than ~156 GiB fails at
 * `CompleteMultipartUpload` — after every byte has been transferred, hours into a large
 * backup. That is the fail-late shape this module has spent the pass removing, so the part
 * size scales with the artifact when the artifact's size is known.
 *
 * The paired property matters as much: in-flight memory is `partSize × queueSize`, so a
 * bigger part must buy FEWER concurrent parts, never more resident memory.
 */

import { describe, expect, it } from "vitest";
import { partLimitCeiling, partSizeFor, queueSizeFor } from "../src/backup/destinations/s3";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
/** S3's hard limit. Nothing we choose may produce more parts than this. */
const S3_MAX_PARTS = 10_000;

const partsFor = (size: number) => Math.ceil(size / partSizeFor(size));
const inFlight = (size: number) => partSizeFor(size) * queueSizeFor(partSizeFor(size));

describe("part size keeps every known size under S3's part limit", () => {
  it("leaves small and mid-size artifacts on the 16 MiB baseline", () => {
    expect(partSizeFor(10 * GiB)).toBe(16 * MiB);
    // #633's own database, comfortably inside the baseline.
    expect(partSizeFor(110 * GiB)).toBe(16 * MiB);
  });

  it("scales up rather than overrunning the part limit", () => {
    for (const size of [156 * GiB, 500 * GiB, 2000 * GiB, 10_000 * GiB]) {
      expect(partsFor(size), `${size / GiB} GiB`).toBeLessThan(S3_MAX_PARTS);
    }
    // The old flat size would have needed this many parts for 500 GiB:
    expect(Math.ceil((500 * GiB) / (16 * MiB))).toBeGreaterThan(S3_MAX_PARTS);
  });

  it("never lets a bigger part size grow resident memory without bound", () => {
    // The whole reason queueSize is derived rather than fixed. A flat queueSize of 4 at a
    // 228 MB part would hold ~912 MB per upload.
    for (const size of [10 * GiB, 156 * GiB, 500 * GiB, 2000 * GiB]) {
      expect(inFlight(size), `${size / GiB} GiB`).toBeLessThanOrEqual(256 * MiB);
    }
    expect(queueSizeFor(16 * MiB)).toBe(4);
    // At least one part must always be allowed, however large.
    expect(queueSizeFor(4 * GiB)).toBe(1);
  });

  it("uses the larger part size for an artifact of unknown size", () => {
    // A DB dump has no sizeHint — it is a stream — so its part size IS its ceiling.
    // 16 MiB put that at ~140 GiB, and #633's dump was 110 GB: close enough that it
    // was a live risk, not a theoretical one.
    for (const unknown of [undefined, 0, -1]) {
      expect(partSizeFor(unknown as number | undefined)).toBe(32 * MiB);
    }
  });

  it("buys the unknown-size reach with concurrency, NOT with memory", () => {
    // The load-bearing property of that change. Doubling the part size halves the
    // queue, so in-flight bytes are unchanged — which matters because an unbounded
    // byte plane is what OOM'd the API in #633. A fix for a ceiling that reintroduces
    // that would be strictly worse than the ceiling.
    const unknown = partSizeFor(undefined);
    const baseline = 16 * MiB;
    expect(unknown).toBe(2 * baseline);
    expect(unknown * queueSizeFor(unknown)).toBe(baseline * queueSizeFor(baseline));
  });

  it("names a ceiling an unknown-size stream can actually reach", () => {
    const unknown = partSizeFor(undefined);
    expect(partsFor(partLimitCeiling(unknown))).toBeLessThanOrEqual(S3_MAX_PARTS);
    // Reach roughly doubled: past ~280 GiB a streamed dump still cannot complete, and
    // that is now enforced early instead of at CompleteMultipartUpload.
    expect(partLimitCeiling(unknown)).toBeGreaterThan(280 * GiB);
    expect(partLimitCeiling(16 * MiB)).toBeLessThan(145 * GiB);
  });
});
