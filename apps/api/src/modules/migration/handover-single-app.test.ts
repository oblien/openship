import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * A moved app must RUN the image the migration just streamed, not rebuild it.
 *
 * The transfer does the expensive part correctly — `docker save | docker load`, tagged on the
 * target, no registry. Then the deploy cloned the repo and ran a full `docker build` anyway,
 * producing a second copy of the same thing. For a 725 MB single app that is minutes of wasted
 * work whose only visible symptom is a migration that looks stuck on its last step.
 *
 * The cause is two fields for two shapes:
 *   - `handoverImages`   — COMPOSE. `pinnedServiceImage` looks a service NAME up in it.
 *   - `handoverAppImage` — SINGLE APP. `pinnedAppImage` reads it, and `snapshotNeedsGitSource`
 *                          keys off the same value, which is what suppresses the clone.
 * The migration set only the first, so every single-app move rebuilt from git.
 */
const orch = readFileSync(new URL("./migration.orchestrator.ts", import.meta.url), "utf8");
const request = (() => {
  // Anchor on semantic statements, not Prettier's current argument layout.
  // `requestBuildAccess(ctx, {` may be one line or several; the assignment
  // immediately after the call is the stable boundary for this request.
  const from = orch.indexOf("const dep = await requestBuildAccess(");
  const to = orch.indexOf("deploymentId = dep.deployment_id;", from);
  if (from < 0 || to < 0) {
    throw new Error("Could not locate the migration target deployment request");
  }
  return orch.slice(from, to);
})();

describe("the migration's target deploy", () => {
  it("passes the compose handover map", () => {
    expect(request).toContain("handoverImages: adopt.handover");
  });

  it("ALSO pins the single-app image when the workload is one service", () => {
    expect(request).toContain("handoverAppImage: Object.values(adopt.handover)[0]");
  });

  it("pins it only for a single service, so compose keeps using the map", () => {
    // Handing a compose project an app-level image would pin the whole release to one service's
    // image — the opposite failure, and a silent one.
    expect(request).toContain("Object.keys(adopt.handover).length === 1");
  });
});

describe("the fields the pin has to satisfy", () => {
  const pinned = readFileSync(
    new URL("../deployments/pinned-artifacts.ts", import.meta.url),
    "utf8",
  );

  it("pinnedAppImage reads handoverAppImage, not the map", () => {
    expect(pinned).toContain("nonEmpty(snapshot?.handoverAppImage)");
  });

  it("a pinned app image is what suppresses the git clone", () => {
    // This is the line that turns the rebuild off; without the scalar it stays true and the
    // target clones and builds.
    expect(pinned).toContain("!pinnedAppImage(snapshot)");
  });
});

/**
 * The pin has to suppress the CLONE, not just the build step — the clone is where the minutes go
 * (`npm i` + `next build` on the target, for an image that had just finished streaming across).
 */
describe("no git source is fetched when the image is pinned", () => {
  const pinned = readFileSync(
    new URL("../deployments/pinned-artifacts.ts", import.meta.url),
    "utf8",
  );
  const pipeline = readFileSync(
    new URL("../deployments/build-pipeline.ts", import.meta.url),
    "utf8",
  );

  it("the clone decision reads the pin", () => {
    expect(pinned).toContain("classNeedsGitSource(snapshotToClass(snapshot))");
    expect(pinned).toContain("!pinnedAppImage(snapshot)");
  });

  it("and the pipeline asks that one resolver rather than deciding again", () => {
    expect(pipeline).toContain("snapshotNeedsGitSource(snapshot, servicePreflightServices)");
  });
});
