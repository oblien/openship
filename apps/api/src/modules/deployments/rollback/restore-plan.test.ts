import { describe, it, expect } from "vitest";
import {
  COMPOSE_SENTINEL,
  ROLLBACK_ERROR_CODES,
  planNeedsRepository,
  planRestore,
  type RestorePlanInput,
} from "./restore-plan";

/** A restorable single-app release on a Docker host, unless overridden. */
const input = (over: Partial<RestorePlanInput> = {}): RestorePlanInput => ({
  target: {
    id: "dep-old",
    status: "ready",
    containerId: "container-old",
    imageRef: "openship/app-web:bld_old",
    commitSha: "abc1234def",
    artifactRetainedAt: new Date("2026-07-01T00:00:00Z"),
    meta: { framework: "node", port: 3000 },
    ...(over.target ?? {}),
  },
  project: { activeDeploymentId: "dep-new", ...(over.project ?? {}) },
  unitRestore: over.unitRestore ?? false,
  serviceImages: over.serviceImages,
  imagePresent: over.imagePresent ?? (() => true),
  pathPresent: over.pathPresent ?? (() => true),
});

describe("planRestore — eligibility", () => {
  it("refuses a deployment that never succeeded", () => {
    const plan = planRestore(input({ target: { status: "failed" } as never }));
    expect(plan).toMatchObject({ mode: "ineligible", code: ROLLBACK_ERROR_CODES.NOT_READY });
  });

  it("accepts partial_failure — some services are up and it's a real restore point", () => {
    const plan = planRestore(input({ target: { status: "partial_failure" } as never }));
    expect(plan.mode).toBe("redeploy-pinned");
  });

  it("refuses the release that is already live", () => {
    const plan = planRestore(input({ project: { activeDeploymentId: "dep-old" } }));
    expect(plan).toMatchObject({ mode: "ineligible", code: ROLLBACK_ERROR_CODES.ALREADY_ACTIVE });
  });
});

describe("planRestore — eligibility (snapshot)", () => {
  it("refuses a release that never recorded a config snapshot", () => {
    // Legacy rows predate the frozen snapshot. Replaying them is impossible, and
    // starting a deploy that dies deep in the pipeline is the worse failure.
    for (const meta of [null, undefined, {}]) {
      const plan = planRestore(input({ target: { meta } as never }));
      expect(plan).toMatchObject({
        mode: "ineligible",
        code: ROLLBACK_ERROR_CODES.ARTIFACT_GONE,
      });
    }
  });

  it("still allows an in-place unit swap without one — nothing is replayed", () => {
    const plan = planRestore(input({ unitRestore: true, target: { meta: null } as never }));
    expect(plan).toEqual({ mode: "unit-swap" });
  });
});

describe("planRestore — docker (image is the artifact)", () => {
  it("pins the release's own image so the deploy skips the build", () => {
    expect(planRestore(input())).toEqual({
      mode: "redeploy-pinned",
      handoverImages: {},
      handoverAppImage: "openship/app-web:bld_old",
      rebuildServices: [],
    });
  });

  it("degrades to a rebuild when the image is gone from the host", () => {
    const plan = planRestore(input({ imagePresent: () => false }));
    expect(plan).toEqual({ mode: "rebuild", commitSha: "abc1234def" });
  });

  it("never treats the compose sentinel as a real image", () => {
    // A compose release stores "compose" in image_ref; taking it literally is
    // what made restore try `createContainer({ Image: "compose" })`.
    const plan = planRestore(
      input({ target: { imageRef: COMPOSE_SENTINEL } as never, serviceImages: [] }),
    );
    expect(plan).toEqual({ mode: "rebuild", commitSha: "abc1234def" });
  });

  it("ignores a blank image ref", () => {
    const plan = planRestore(input({ target: { imageRef: "   " } as never }));
    expect(plan.mode).toBe("rebuild");
  });

  it("is ineligible only when there is neither an artifact nor a commit", () => {
    const plan = planRestore(
      input({
        target: { imageRef: null, commitSha: null } as never,
        imagePresent: () => false,
      }),
    );
    expect(plan).toMatchObject({ mode: "ineligible", code: ROLLBACK_ERROR_CODES.ARTIFACT_GONE });
  });
});

describe("planRestore — compose (per-service images)", () => {
  const services = [
    { serviceName: "web", imageRef: "openship/app-web:bld_1" },
    { serviceName: "api", imageRef: "openship/app-api:bld_1" },
    { serviceName: "db", imageRef: "postgres:16-alpine" },
  ];

  it("pins every service whose image is still there, keyed by NAME", () => {
    const plan = planRestore(
      input({ target: { imageRef: COMPOSE_SENTINEL } as never, serviceImages: services }),
    );
    expect(plan).toEqual({
      mode: "redeploy-pinned",
      handoverImages: {
        web: "openship/app-web:bld_1",
        api: "openship/app-api:bld_1",
        db: "postgres:16-alpine",
      },
      rebuildServices: [],
    });
  });

  it("mixes pinned + rebuilt when only SOME images survived", () => {
    const plan = planRestore(
      input({
        target: { imageRef: COMPOSE_SENTINEL } as never,
        serviceImages: services,
        imagePresent: (ref) => ref !== "openship/app-api:bld_1",
      }),
    );
    expect(plan).toMatchObject({
      mode: "redeploy-pinned",
      handoverImages: { web: "openship/app-web:bld_1", db: "postgres:16-alpine" },
      rebuildServices: ["api"],
    });
    // A service with no pin falls into the normal buildable set, so this deploy
    // still needs the repo.
    expect(planNeedsRepository(plan)).toBe(true);
  });

  it("rebuilds the whole release when no service image survived", () => {
    const plan = planRestore(
      input({
        target: { imageRef: COMPOSE_SENTINEL } as never,
        serviceImages: services,
        imagePresent: () => false,
      }),
    );
    expect(plan).toEqual({ mode: "rebuild", commitSha: "abc1234def" });
  });

  it("skips rows with no service name (nothing to key a handover by)", () => {
    const plan = planRestore(
      input({
        target: { imageRef: null } as never,
        serviceImages: [
          { serviceName: null, imageRef: "openship/orphan:bld_1" },
          { serviceName: "web", imageRef: "openship/app-web:bld_1" },
        ],
      }),
    );
    expect(plan).toMatchObject({
      mode: "redeploy-pinned",
      handoverImages: { web: "openship/app-web:bld_1" },
      rebuildServices: [],
    });
  });
});

describe("planRestore — static (a directory of files is the artifact)", () => {
  const RELEASE_DIR = "/var/lib/openship/static/releases/dep-old";

  // A static release records a host PATH where others record a container id.
  const staticInput = (over: Partial<RestorePlanInput> = {}) =>
    input({
      ...over,
      target: { containerId: RELEASE_DIR, imageRef: null, ...(over.target ?? {}) } as never,
    });

  it("pins the retained release directory — no image, no rebuild", () => {
    expect(planRestore(staticInput({ pathPresent: () => true }))).toEqual({
      mode: "redeploy-pinned",
      handoverImages: {},
      handoverStaticDir: RELEASE_DIR,
      rebuildServices: [],
    });
  });

  it("needs no repository, so an instant static restore skips the clone", () => {
    expect(planNeedsRepository(planRestore(staticInput({ pathPresent: () => true })))).toBe(false);
  });

  it("rebuilds when the release directory was pruned off the host", () => {
    expect(planRestore(staticInput({ pathPresent: () => false }))).toEqual({
      mode: "rebuild",
      commitSha: "abc1234def",
    });
  });

  it("is ineligible when the files are gone and there's no commit", () => {
    const plan = planRestore(
      staticInput({ target: { commitSha: null } as never, pathPresent: () => false }),
    );
    expect(plan).toMatchObject({ mode: "ineligible", code: ROLLBACK_ERROR_CODES.ARTIFACT_GONE });
  });

  it("NEVER routes a static release through the unit swap", () => {
    // bare advertises `unitRestore`, but a static release has no supervisor unit
    // — its "container id" is a directory. Restarting a path is meaningless.
    const plan = planRestore(staticInput({ unitRestore: true, pathPresent: () => true }));
    expect(plan.mode).toBe("redeploy-pinned");
  });
});

describe("planRestore — bare/cloud (the unit is the artifact)", () => {
  it("restarts the retained unit in place", () => {
    expect(planRestore(input({ unitRestore: true }))).toEqual({ mode: "unit-swap" });
  });

  it("falls back to an image/commit restore when the unit was purged", () => {
    const plan = planRestore(
      input({ unitRestore: true, target: { artifactRetainedAt: null } as never }),
    );
    expect(plan.mode).toBe("redeploy-pinned");
  });

  it("falls back when the unit id is gone", () => {
    const plan = planRestore(
      input({ unitRestore: true, target: { containerId: null } as never }),
    );
    expect(plan.mode).toBe("redeploy-pinned");
  });
});

describe("planNeedsRepository — what gates the clone + GitHub access", () => {
  it("is false for a fully-pinned restore", () => {
    expect(planNeedsRepository(planRestore(input()))).toBe(false);
  });

  it("is false for a unit swap", () => {
    expect(planNeedsRepository(planRestore(input({ unitRestore: true })))).toBe(false);
  });

  it("is true for a rebuild", () => {
    expect(planNeedsRepository(planRestore(input({ imagePresent: () => false })))).toBe(true);
  });

  it("is false for an ineligible plan (nothing will run)", () => {
    expect(
      planNeedsRepository(planRestore(input({ project: { activeDeploymentId: "dep-old" } }))),
    ).toBe(false);
  });
});
