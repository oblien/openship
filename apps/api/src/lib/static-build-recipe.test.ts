import { describe, it, expect } from "vitest";
import {
  hasSourceBuildRecipe,
  isStaticService,
  resolveSubAppRecipe,
} from "./deployable-service";

/**
 * A static sub-app with NO build command must be deployable — WITHOUT loosening
 * the gate that a project-level caller shares.
 *
 * Two questions live next to each other here and must not be merged:
 *
 *   `hasSourceBuildRecipe` — "does this unit declare a recipe?" Shared verbatim
 *      with #589's phantom-app-row gate, which asks it about a PROJECT. Answering
 *      "yes, it's a frontend framework" here made a command-less vite/react
 *      project whose `hasServer` is not `false` materialize a phantom app service
 *      row again.
 *   `isStaticService` — "is THIS ROW served as files?" Needs the row's `kind` and
 *      its RESOLVED start command, so it is inherently row-level. This is the
 *      arm that makes a just-files sub-app buildable, and it belongs at the build
 *      selector.
 *
 * `resolveSubAppRecipe` is why both can be asked correctly: a monorepo row
 * legitimately leaves its commands null and inherits them from the project, so
 * every such question has to be asked of the resolved values.
 */

const SNAPSHOT = {
  framework: "node",
  installCommand: "npm ci",
  buildCommand: "npm run build",
  startCommand: "node index.js",
};

describe("hasSourceBuildRecipe", () => {
  it("accepts the three declared recipes", () => {
    expect(hasSourceBuildRecipe({ framework: "docker" })).toBe(true);
    expect(hasSourceBuildRecipe({ framework: "node", buildCommand: "npm run build" })).toBe(true);
    expect(hasSourceBuildRecipe({ framework: "node", startCommand: "node index.js" })).toBe(true);
  });

  it("REFUSES a bare static/frontend framework — that is #589's gate", () => {
    // The regression guard. A frontend framework is not, by itself, evidence that a
    // PROJECT has a source-build recipe; reading it as such reintroduces the
    // phantom app service row.
    for (const framework of ["static", "vite", "react", "astro", "gatsby", "blazor"]) {
      expect(hasSourceBuildRecipe({ framework, buildCommand: "", startCommand: "" })).toBe(false);
    }
  });

  it("still REFUSES a row with no recipe at all", () => {
    expect(hasSourceBuildRecipe({ framework: "unknown" })).toBe(false);
    expect(hasSourceBuildRecipe({})).toBe(false);
  });
});

describe("isStaticService — the arm that makes a just-files sub-app buildable", () => {
  it("accepts a command-less monorepo frontend/static row", () => {
    for (const framework of ["static", "vite", "react", "angular", "blazor"]) {
      expect(isStaticService({ kind: "monorepo", framework, startCommand: "" })).toBe(true);
    }
  });

  it("a start command means a running process, not files", () => {
    expect(
      isStaticService({ kind: "monorepo", framework: "vite", startCommand: "node server.js" }),
    ).toBe(false);
  });

  it("never claims a compose row", () => {
    // A compose service is an image or a Dockerfile; the category of a `framework`
    // column it does not use must not make it static.
    expect(isStaticService({ kind: "compose", framework: "static", startCommand: "" })).toBe(false);
  });

  it("rejects a backend framework and an unknown one", () => {
    expect(isStaticService({ kind: "monorepo", framework: "node", startCommand: "" })).toBe(false);
    expect(isStaticService({ kind: "monorepo", framework: "unknown", startCommand: "" })).toBe(false);
    expect(isStaticService({ kind: "monorepo", framework: null, startCommand: "" })).toBe(false);
  });
});

describe("resolveSubAppRecipe", () => {
  it("prefers the row and falls back to the snapshot per FIELD", () => {
    expect(
      resolveSubAppRecipe(
        { kind: "monorepo", framework: "vite", buildCommand: "vite build" },
        SNAPSHOT,
      ),
    ).toEqual({
      kind: "monorepo",
      framework: "vite",
      installCommand: "npm ci",
      buildCommand: "vite build",
      startCommand: "node index.js",
    });
  });

  it("is what stops the static decision disagreeing with the buildable one", () => {
    // THE drift this helper exists to kill. An inheriting sub-app carries no
    // startCommand of its own; the selector resolved the fallback while the
    // static-vs-server decision read the RAW row, so the row was selected as a
    // server and then built as static FILES.
    const row = { kind: "monorepo", framework: "vite", startCommand: null };
    expect(isStaticService(row)).toBe(true); // raw row: looks static
    expect(isStaticService(resolveSubAppRecipe(row, SNAPSHOT))).toBe(false); // resolved: a server
  });

  it("keeps a just-files sub-app static when the snapshot has no start command either", () => {
    const resolved = resolveSubAppRecipe(
      { kind: "monorepo", framework: "static" },
      { framework: "static", installCommand: "", buildCommand: "", startCommand: "" },
    );
    expect(isStaticService(resolved)).toBe(true);
    // And the shared project-level gate still says "no declared recipe" — which is
    // correct, and why the static arm cannot live inside it.
    expect(hasSourceBuildRecipe(resolved)).toBe(false);
  });

  it("normalizes an absent kind to compose, like serviceKind does", () => {
    expect(resolveSubAppRecipe({ framework: "static" }, {}).kind).toBe("compose");
  });
});
