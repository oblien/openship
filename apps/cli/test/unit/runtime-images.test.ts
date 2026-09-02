import { describe, it, expect } from "vitest";

/**
 * `openship system runtime-images` decides which previous openship-api /
 * -dashboard / -edge images an update left behind may go. These pin the
 * safety rules: a referenced image is never a candidate, the kept-previous quota
 * is per repository, and a tag we can't order is never called old.
 */

import {
  compareVersionTags,
  parseContainerImageRefs,
  parseDockerImages,
  planRuntimeImagePrune,
} from "../../src/lib/runtime-images";

const rows = (...lines: string[]) => parseDockerImages(lines.join("\n") + "\n");

describe("planRuntimeImagePrune", () => {
  it("keeps the referenced version + N previous per repository, marks older versions superseded, ignores foreign images", () => {
    const images = rows(
      "ghcr.io/oblien/openship-api\t0.6.1\ta1\t500MB\t2026-06-01",
      "ghcr.io/oblien/openship-api\t0.6.9\ta9\t500MB\t2026-08-30",
      "ghcr.io/oblien/openship-api\t0.6.5\ta5\t500MB\t2026-07-15",
      "ghcr.io/oblien/openship-api\t0.6.7\ta7\t500MB\t2026-08-01",
      "ghcr.io/oblien/openship-edge\t0.6.9\te9\t80MB\t2026-08-30",
      "ghcr.io/oblien/openship-edge\t0.6.7\te7\t80MB\t2026-08-01",
      "postgres\t16-alpine\tp1\t240MB\t2026-01-01",
      "openship/rentabo-test\tbld_x\tb1\t900MB\t2026-08-20",
    );
    const inUse = parseContainerImageRefs(
      "ghcr.io/oblien/openship-api:0.6.9\nghcr.io/oblien/openship-edge:0.6.9\npostgres:16-alpine\n",
    );
    const plan = planRuntimeImagePrune(images, { inUse, keepPrevious: 1 });
    expect(plan.map((v) => [v.ref, v.action, v.reason])).toEqual([
      ["ghcr.io/oblien/openship-api:0.6.9", "keep", "in-use"],
      ["ghcr.io/oblien/openship-api:0.6.7", "keep", "previous"],
      ["ghcr.io/oblien/openship-api:0.6.5", "remove", "superseded"],
      ["ghcr.io/oblien/openship-api:0.6.1", "remove", "superseded"],
      ["ghcr.io/oblien/openship-edge:0.6.9", "keep", "in-use"],
      ["ghcr.io/oblien/openship-edge:0.6.7", "keep", "previous"],
    ]);
  });

  it("never marks a referenced image even when it is the oldest, and never orders a non-version tag", () => {
    const images = rows(
      "ghcr.io/oblien/openship-api\t0.6.9\ta9\t500MB\t2026-08-30",
      "ghcr.io/oblien/openship-api\t0.6.1\ta1\t500MB\t2026-06-01",
      "ghcr.io/oblien/openship-api\tlatest\ta9\t500MB\t2026-08-30",
      "ghcr.io/oblien/openship-api\tmain\tam\t500MB\t2026-08-30",
    );
    // A stopped container still pinned to 0.6.1; `docker ps` prints the bare repo for :latest.
    const inUse = parseContainerImageRefs(
      "ghcr.io/oblien/openship-api:0.6.1\nghcr.io/oblien/openship-api\n",
    );
    const plan = planRuntimeImagePrune(images, { inUse, keepPrevious: 0 });
    expect(plan.map((v) => [v.tag, v.action, v.reason])).toEqual([
      ["0.6.9", "remove", "superseded"],
      ["0.6.1", "keep", "in-use"],
      ["latest", "keep", "in-use"],
      ["main", "keep", "not-a-version"],
    ]);
  });
});

describe("compareVersionTags", () => {
  it("orders numerically, not lexically, and puts a pre-release below its release", () => {
    expect(compareVersionTags("0.6.10", "0.6.9")).toBeGreaterThan(0);
    expect(compareVersionTags("v0.7.0", "0.6.10")).toBeGreaterThan(0);
    expect(compareVersionTags("0.7.0-rc.1", "0.7.0")).toBeLessThan(0);
    expect(compareVersionTags("latest", "0.6.9")).toBe(0);
  });
});
