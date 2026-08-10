import { describe, expect, it } from "vitest";

import { resolveComposeBuildContext } from "../../../src/modules/deployments/compose/build.service";

/**
 * Compose resolves `build.context` relative to the COMPOSE FILE's directory, not
 * the repo root — but BuildConfig.rootDirectory is relative to the clone root.
 * Before this translation existed, a compose file outside the repo root built the
 * wrong directory (`build: ./api` under `deploy/docker-compose` built `<root>/api`).
 */
describe("resolveComposeBuildContext", () => {
  describe("compose at the repo root (unchanged behaviour)", () => {
    // Guards the regression risk: every pre-existing compose project has an
    // empty / "." / "./" rootDirectory and must resolve exactly as before.
    it.each(["", ".", "./"])("root %j passes the context through", (composeDirectory) => {
      expect(resolveComposeBuildContext(composeDirectory, "api")).toBe("api");
      expect(resolveComposeBuildContext(composeDirectory, "./api")).toBe("api");
      expect(resolveComposeBuildContext(composeDirectory, ".")).toBe("");
      expect(resolveComposeBuildContext(composeDirectory, "./")).toBe("");
      expect(resolveComposeBuildContext(composeDirectory, "services/api")).toBe("services/api");
    });
  });

  describe("compose in a subdirectory", () => {
    it("resolves a relative context against the compose directory", () => {
      expect(resolveComposeBuildContext("deploy/docker-compose", "./api")).toBe(
        "deploy/docker-compose/api",
      );
      expect(resolveComposeBuildContext("deploy/docker-compose", "api")).toBe(
        "deploy/docker-compose/api",
      );
      expect(resolveComposeBuildContext("deploy/docker-compose", "api/worker")).toBe(
        "deploy/docker-compose/api/worker",
      );
    });

    it("resolves `..` back toward the repo root", () => {
      // The normal shape for a compose file kept in a deploy/ subfolder: it points
      // back at the source it builds.
      expect(resolveComposeBuildContext("deploy/docker-compose", "../../api")).toBe("api");
      expect(resolveComposeBuildContext("deploy/docker-compose", "../..")).toBe("");
      expect(resolveComposeBuildContext("deploy/docker-compose", "../compose-api")).toBe(
        "deploy/compose-api",
      );
    });

    it("treats the compose directory itself as the context for `.`", () => {
      expect(resolveComposeBuildContext("deploy/docker-compose", ".")).toBe(
        "deploy/docker-compose",
      );
      expect(resolveComposeBuildContext("deploy/docker-compose", "./")).toBe(
        "deploy/docker-compose",
      );
    });

    it("normalizes a trailing slash and a leading ./ on the compose directory", () => {
      expect(resolveComposeBuildContext("./deploy/docker-compose/", "./api")).toBe(
        "deploy/docker-compose/api",
      );
    });
  });

  describe("paths that escape the clone root", () => {
    // There is no such directory in the checkout, so there is nothing to build
    // there. Fall back to the compose directory rather than emitting a path that
    // walks out of the clone.
    it("falls back to the compose directory", () => {
      expect(resolveComposeBuildContext("deploy", "../../../etc")).toBe("deploy");
      expect(resolveComposeBuildContext("deploy/docker-compose", "../../../..")).toBe(
        "deploy/docker-compose",
      );
      expect(resolveComposeBuildContext("", "../outside")).toBe("");
      expect(resolveComposeBuildContext(".", "../outside")).toBe("");
    });
  });

  it("handles backslash separators in a declared context", () => {
    expect(resolveComposeBuildContext("deploy", "sub\\api")).toBe("deploy/sub/api");
  });

  // The directory half is normalized by the same shared helper as the context
  // half. It used to use a weaker local regex pair that split the context on
  // [\\/] but the directory on / only — so these produced literally broken
  // paths ("  deploy  /api", "deploy\\compose/api").
  it("normalizes the compose directory the same way as the context", () => {
    expect(resolveComposeBuildContext("deploy\\compose", "api")).toBe("deploy/compose/api");
    expect(resolveComposeBuildContext("  deploy  ", "api")).toBe("deploy/api");
    expect(resolveComposeBuildContext("deploy//sub", "api")).toBe("deploy/sub/api");
    expect(resolveComposeBuildContext("/deploy/", "api")).toBe("deploy/api");
  });

  it("keeps the escape fallback consistent for every spelling of the root", () => {
    for (const root of ["", ".", "./"]) {
      expect(resolveComposeBuildContext(root, "../outside")).toBe("");
      expect(resolveComposeBuildContext(root, "./api")).toBe("api");
    }
  });
});
