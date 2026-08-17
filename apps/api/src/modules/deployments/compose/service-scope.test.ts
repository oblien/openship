import { describe, it, expect } from "vitest";
import { isUntargetedAndUndeployable, resolveDeployImage } from "./service-scope";

/**
 * GH-585. A deploy scoped with `--service-ids A` hard-failed when an UNSCOPED sibling B was
 * enabled but had never been built: B fell through to "no image available", was recorded
 * `failure`, and that one row rolled the whole deployment up to `partial_failure` — and,
 * because a failure also marks the service unavailable, blocked any TARGETED service that
 * `depends_on` B, so A never deployed either.
 *
 * These pin both halves of the gate that closes it: what it skips, and — just as important —
 * what it must still let fail.
 */

const TARGET_A = new Set(["svc-a"]);

describe("resolveDeployImage", () => {
  it("prefers a freshly built image over everything else", () => {
    expect(
      resolveDeployImage({
        builtImage: "openship/web:abc123",
        rowImage: "nginx:alpine",
        previousImageRef: "openship/web:old",
      }),
    ).toBe("openship/web:abc123");
  });

  it("falls back to the service row's configured (pulled/external) image", () => {
    expect(resolveDeployImage({ rowImage: "postgres:16-alpine" })).toBe("postgres:16-alpine");
  });

  it("falls back to the previous deployment's image — the env-only refresh / revive case", () => {
    expect(resolveDeployImage({ previousImageRef: "openship/api:v7" })).toBe("openship/api:v7");
  });

  it('is "" when nothing is available at all', () => {
    expect(resolveDeployImage({})).toBe("");
    expect(resolveDeployImage({ rowImage: null, previousImageRef: null })).toBe("");
  });
});

describe("isUntargetedAndUndeployable", () => {
  // THE fix. B is enabled, was never built, and this deploy wasn't asked about it.
  it("skips an untargeted service with no image", () => {
    expect(
      isUntargetedAndUndeployable({ serviceId: "svc-b", image: "", targetServiceIds: TARGET_A }),
    ).toBe(true);
  });

  // The other half: an in-scope service with no image is a REAL failure and must stay one,
  // or the fix would turn every genuinely broken build into a silent skip.
  it("does NOT skip a TARGETED service with no image", () => {
    expect(
      isUntargetedAndUndeployable({ serviceId: "svc-a", image: "", targetServiceIds: TARGET_A }),
    ).toBe(false);
  });

  // A full deploy targets every enabled service, so "no image" there is unambiguous.
  it("does NOT skip anything on a full deploy (no target subset)", () => {
    expect(isUntargetedAndUndeployable({ serviceId: "svc-b", image: "" })).toBe(false);
    expect(isUntargetedAndUndeployable({ serviceId: "svc-a", image: "" })).toBe(false);
  });

  // A partial deploy still revives an untargeted sibling whose container died — that
  // self-heal is unchanged, and it's why the gate keys off the image and not the subset alone.
  it("does NOT skip an untargeted service that has an image to revive from", () => {
    expect(
      isUntargetedAndUndeployable({
        serviceId: "svc-b",
        image: "postgres:16-alpine",
        targetServiceIds: TARGET_A,
      }),
    ).toBe(false);
  });

  it("treats an empty target set as a full deploy, not as 'nothing is targeted'", () => {
    // A Set is truthy, so the literal reading of "not in the subset" would skip EVERY
    // service in the project. The pipeline normalizes an empty subset to `undefined` before
    // it gets here — this pins the behaviour if that ever regresses.
    expect(
      isUntargetedAndUndeployable({
        serviceId: "svc-a",
        image: "",
        targetServiceIds: new Set(),
      }),
    ).toBe(false);
  });
});
