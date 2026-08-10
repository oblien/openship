/**
 * Workspace detector parser tests.
 *
 * One describe block per detector; each verifies:
 *   - the happy-path manifest produces the expected sub-project paths
 *   - the negative case (manifest present but doesn't declare a workspace)
 *     returns []
 *   - format edge cases that have bitten real users (BOM, comments, multi-line
 *     arrays, both quoting styles, etc.)
 *
 * Add a fixture here when introducing a new workspace family - the rest of
 * the system (project-root-detector, monorepo discovery) is registry-driven
 * and needs no extra wiring.
 */

import { describe, it, expect } from "vitest";
import {
  WORKSPACE_DETECTORS,
  findMatchingDetectors,
  parseWorkspaceManifest,
} from "@repo/core";

function findDetector(id: string) {
  const detector = WORKSPACE_DETECTORS.find((d) => d.id === id);
  if (!detector) throw new Error(`detector ${id} is missing from the registry`);
  return detector;
}

// ─── pnpm ────────────────────────────────────────────────────────────────────

describe("pnpm-workspace.yaml detector", () => {
  const pnpm = findDetector("pnpm");

  it("extracts packages: list with mixed quoting + comments", () => {
    expect(
      pnpm.parseSubProjects(`# top level comment
packages:
  - 'apps/*'   # inline comment
  - "packages/*"
  - tooling/cli
`),
    ).toEqual(["apps/*", "packages/*", "tooling/cli"]);
  });

  it("returns [] when packages: block is absent (catalog-only manifest)", () => {
    expect(
      pnpm.parseSubProjects(`catalog:
  react: ^18
`),
    ).toEqual([]);
  });

  it("stops at the next top-level key", () => {
    expect(
      pnpm.parseSubProjects(`packages:
  - apps/*
catalog:
  - this-isnt-a-package
`),
    ).toEqual(["apps/*"]);
  });

  it("handles a UTF-8 BOM at the start of the file", () => {
    expect(
      pnpm.parseSubProjects(`﻿packages:\n  - apps/*\n`),
    ).toEqual(["apps/*"]);
  });
});

// ─── npm / yarn / bun workspaces ─────────────────────────────────────────────

describe("package.json workspaces detector", () => {
  const npm = findDetector("npm-workspaces");

  it("array form", () => {
    expect(
      npm.parseSubProjects(JSON.stringify({ workspaces: ["apps/*", "packages/*"] })),
    ).toEqual(["apps/*", "packages/*"]);
  });

  it("object form (yarn classic)", () => {
    expect(
      npm.parseSubProjects(
        JSON.stringify({
          workspaces: { packages: ["packages/*"], nohoist: ["**/react"] },
        }),
      ),
    ).toEqual(["packages/*"]);
  });

  it("returns [] for a package.json without workspaces", () => {
    expect(
      npm.parseSubProjects(JSON.stringify({ name: "single-app", version: "1.0.0" })),
    ).toEqual([]);
  });

  it("ignores junk values in the array", () => {
    expect(
      npm.parseSubProjects(JSON.stringify({ workspaces: ["apps/*", "", 123, null] })),
    ).toEqual(["apps/*"]);
  });
});

// ─── Rush ────────────────────────────────────────────────────────────────────

describe("rush.json detector", () => {
  const rush = findDetector("rush");

  it("pulls projectFolder from each entry", () => {
    expect(
      rush.parseSubProjects(
        JSON.stringify({
          projects: [
            { packageName: "@org/app", projectFolder: "apps/app" },
            { packageName: "@org/lib", projectFolder: "libraries/lib" },
          ],
        }),
      ),
    ).toEqual(["apps/app", "libraries/lib"]);
  });

  it("returns [] for a rush.json without projects", () => {
    expect(rush.parseSubProjects(JSON.stringify({ rushVersion: "5.0.0" }))).toEqual([]);
  });

  it("skips malformed project entries", () => {
    expect(
      rush.parseSubProjects(
        JSON.stringify({
          projects: [
            { packageName: "@org/app", projectFolder: "apps/app" },
            { packageName: "@org/broken" }, // missing folder
            null,
            "not an object",
          ],
        }),
      ),
    ).toEqual(["apps/app"]);
  });

  it("reads a JSONC rush.json (the shape `rush init` generates)", () => {
    expect(
      rush.parseSubProjects(`/**
 * This is the main configuration file for Rush.
 * For full documentation, please see https://rushjs.io
 */
{
  "$schema": "https://developer.microsoft.com/json-schemas/rush/v5/rush.schema.json",
  "rushVersion": "5.140.0",
  "pnpmVersion": "8.15.8",

  /**
   * Rush can manage everything in the repo.
   */
  "projects": [
    // The web app
    {
      "packageName": "@org/app",
      "projectFolder": "apps/app"
    },
    {
      "packageName": "@org/lib",
      "projectFolder": "libraries/lib" // shared code
    }
  ]
}
`),
    ).toEqual(["apps/app", "libraries/lib"]);
  });

  it("keeps a `//` that lives inside a JSON string", () => {
    expect(
      rush.parseSubProjects(`{
  "$schema": "https://developer.microsoft.com/json-schemas/rush/v5/rush.schema.json",
  "projects": [{ "packageName": "@org/app", "projectFolder": "apps/app" }]
}
`),
    ).toEqual(["apps/app"]);
  });
});

// ─── Cargo (Rust) ────────────────────────────────────────────────────────────

describe("Cargo.toml detector", () => {
  const cargo = findDetector("cargo");

  it("extracts members from [workspace]", () => {
    expect(
      cargo.parseSubProjects(`[workspace]
members = ["crates/core", "crates/server", "examples/*"]
resolver = "2"
`),
    ).toEqual(["crates/core", "crates/server", "examples/*"]);
  });

  it("handles multi-line members array", () => {
    expect(
      cargo.parseSubProjects(`[workspace]
members = [
  "crates/core",
  "crates/server",  # inline TOML comment
  "examples/*",
]
`),
    ).toEqual(["crates/core", "crates/server", "examples/*"]);
  });

  it("returns [] for a single-crate Cargo.toml without [workspace]", () => {
    expect(
      cargo.parseSubProjects(`[package]
name = "single"
version = "0.1.0"
[dependencies]
serde = "1"
`),
    ).toEqual([]);
  });

  it("doesn't break when value strings contain '['", () => {
    expect(
      cargo.parseSubProjects(`[workspace]
members = ["foo[1]", "bar"]
`),
    ).toEqual(["foo[1]", "bar"]);
  });
});

// ─── Go workspaces ───────────────────────────────────────────────────────────

describe("go.work detector", () => {
  const go = findDetector("go-work");

  it("extracts paths from a use ( ... ) block", () => {
    expect(
      go.parseSubProjects(`go 1.22

use (
    ./hello
    ./helloutil
)
`),
    ).toEqual(["./hello", "./helloutil"]);
  });

  it("extracts paths from single-line use directives", () => {
    expect(
      go.parseSubProjects(`go 1.22

use ./api
use ./worker
`),
    ).toEqual(["./api", "./worker"]);
  });

  it("merges block + single-line forms and dedupes", () => {
    expect(
      go.parseSubProjects(`go 1.22
use ./api
use (
    ./api
    ./worker
)
`),
    ).toEqual(["./api", "./worker"]);
  });

  it("strips line comments", () => {
    expect(
      go.parseSubProjects(`go 1.22
use (
    ./api // primary
    ./worker
)
`),
    ).toEqual(["./api", "./worker"]);
  });
});

// ─── Python (uv) ─────────────────────────────────────────────────────────────

describe("pyproject.toml (uv) detector", () => {
  const uv = findDetector("uv");

  it("extracts members from [tool.uv.workspace]", () => {
    expect(
      uv.parseSubProjects(`[project]
name = "monorepo-root"
version = "0.0.1"

[tool.uv.workspace]
members = ["packages/api", "packages/worker"]
`),
    ).toEqual(["packages/api", "packages/worker"]);
  });

  it("returns [] for a regular pyproject.toml without uv workspace", () => {
    expect(
      uv.parseSubProjects(`[project]
name = "single"
version = "1.0.0"
dependencies = ["fastapi[standard]"]
`),
    ).toEqual([]);
  });
});

// ─── Elixir umbrella ─────────────────────────────────────────────────────────

describe("mix.exs (Elixir umbrella) detector", () => {
  const mix = findDetector("elixir-umbrella");

  it("emits <apps_path>/* glob when apps_path is set", () => {
    expect(
      mix.parseSubProjects(`defmodule Umbrella.MixProject do
  use Mix.Project
  def project do
    [apps_path: "apps", apps: [:web, :worker]]
  end
end
`),
    ).toEqual(["apps/*"]);
  });

  it("returns [] for a regular non-umbrella mix.exs", () => {
    expect(
      mix.parseSubProjects(`defmodule Single.MixProject do
  use Mix.Project
  def project do
    [app: :single, version: "0.1.0"]
  end
end
`),
    ).toEqual([]);
  });
});

// ─── Maven ───────────────────────────────────────────────────────────────────

describe("pom.xml (Maven) detector", () => {
  const maven = findDetector("maven");

  it("extracts <module> entries from <modules>", () => {
    expect(
      maven.parseSubProjects(`<?xml version="1.0" encoding="UTF-8"?>
<project>
  <packaging>pom</packaging>
  <modules>
    <module>app</module>
    <module>services/api</module>
    <module>libs/shared</module>
  </modules>
</project>
`),
    ).toEqual(["app", "services/api", "libs/shared"]);
  });

  it("returns [] for a single-module pom.xml", () => {
    expect(
      maven.parseSubProjects(`<?xml version="1.0" encoding="UTF-8"?>
<project>
  <groupId>com.example</groupId>
  <artifactId>app</artifactId>
  <version>1.0.0</version>
</project>
`),
    ).toEqual([]);
  });

  it("ignores commented-out <module> entries", () => {
    expect(
      maven.parseSubProjects(`<?xml version="1.0" encoding="UTF-8"?>
<project>
  <packaging>pom</packaging>
  <modules>
    <module>app</module>
    <!-- <module>legacy-api</module> -->
    <!--
      <module>experimental</module>
    -->
    <module>services/api</module>
  </modules>
</project>
`),
    ).toEqual(["app", "services/api"]);
  });

  it("returns [] when the whole <modules> block is commented out", () => {
    expect(
      maven.parseSubProjects(`<?xml version="1.0" encoding="UTF-8"?>
<project>
  <artifactId>app</artifactId>
  <!--
  <modules>
    <module>old</module>
  </modules>
  -->
</project>
`),
    ).toEqual([]);
  });
});

// ─── Gradle ──────────────────────────────────────────────────────────────────

describe("settings.gradle / settings.gradle.kts detector", () => {
  const gradle = findDetector("gradle");

  it("parses Groovy include 'foo', 'bar'", () => {
    expect(
      gradle.parseSubProjects(`rootProject.name = 'monorepo'
include 'app', 'libs:shared'
`),
    ).toEqual(["app", "libs/shared"]);
  });

  it("parses Kotlin include(\":services:api\")", () => {
    expect(
      gradle.parseSubProjects(`rootProject.name = "monorepo"
include(":services:api")
include(":services:worker")
`),
    ).toEqual(["services/api", "services/worker"]);
  });

  it("parses a multi-line Kotlin include( … ) list", () => {
    expect(
      gradle.parseSubProjects(`rootProject.name = "monorepo"
include(
    ":app",
    ":feature:login",
    ":core:data",
)
`),
    ).toEqual(["app", "feature/login", "core/data"]);
  });

  it("parses a Groovy include continued over lines with a trailing comma", () => {
    expect(
      gradle.parseSubProjects(`include ':app',
        ':libs:shared'
`),
    ).toEqual(["app", "libs/shared"]);
  });

  it("ignores includeBuild (composite builds, not modules)", () => {
    expect(
      gradle.parseSubProjects(`rootProject.name = "root"
includeBuild("../shared-lib")
include 'app'
`),
    ).toEqual(["app"]);
  });

  it("ignores includeFlat (sibling directories outside the repo root)", () => {
    expect(
      gradle.parseSubProjects(`rootProject.name = "root"
includeFlat 'sibling-lib'
include 'app'
`),
    ).toEqual(["app"]);
  });

  it("strips // and /* */ comments", () => {
    expect(
      gradle.parseSubProjects(`rootProject.name = "root"
// include 'skipped'
include 'app' /* keep */
`),
    ).toEqual(["app"]);
  });
});

// ─── .NET solutions ──────────────────────────────────────────────────────────

describe("*.sln (.NET) detector", () => {
  const sln = findDetector("dotnet-sln");

  it("extracts project directory paths", () => {
    expect(
      sln.parseSubProjects(`Microsoft Visual Studio Solution File, Format Version 12.00
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Api", "src\\Api\\Api.csproj", "{8E2C1B3F-1234-5678-9ABC-123456789ABC}"
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Worker", "src\\Worker\\Worker.csproj", "{8E2C1B3F-1234-5678-9ABC-123456789ABD}"
`),
    ).toEqual(["src/Api", "src/Worker"]);
  });

  it("filters out solution folders (no project file extension)", () => {
    expect(
      sln.parseSubProjects(`Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Api", "src\\Api\\Api.csproj", "{X}"
Project("{2150E333-8FDC-42A3-9474-1A3956D46DE8}") = "tests", "tests", "{Y}"
`),
    ).toEqual(["src/Api"]);
  });

  it("supports forward slashes in path", () => {
    expect(
      sln.parseSubProjects(`Project("{X}") = "Api", "src/Api/Api.csproj", "{X}"
`),
    ).toEqual(["src/Api"]);
  });

  it("emits '.' for a project at the solution root", () => {
    expect(
      sln.parseSubProjects(`Project("{X}") = "Single", "Single.csproj", "{X}"
`),
    ).toEqual(["."]);
  });
});

// ─── Registry-level helpers ──────────────────────────────────────────────────

describe("findMatchingDetectors", () => {
  it("matches static-string manifests case-insensitively", () => {
    expect(findMatchingDetectors("PNPM-Workspace.YAML").map((d) => d.id)).toEqual(["pnpm"]);
    expect(findMatchingDetectors("rush.json").map((d) => d.id)).toEqual(["rush"]);
    expect(findMatchingDetectors("go.work").map((d) => d.id)).toEqual(["go-work"]);
  });

  it("matches *.sln via regex", () => {
    expect(findMatchingDetectors("MyApp.sln").map((d) => d.id)).toEqual(["dotnet-sln"]);
    expect(findMatchingDetectors("MyApp.SLN").map((d) => d.id)).toEqual(["dotnet-sln"]);
  });

  it("returns nothing for unrelated files", () => {
    expect(findMatchingDetectors("readme.md")).toEqual([]);
  });
});

describe("parseWorkspaceManifest convenience", () => {
  it("returns the detector + patterns when both filename and content match", () => {
    const matches = parseWorkspaceManifest("Cargo.toml", `[workspace]
members = ["a", "b"]
`);
    expect(matches).toHaveLength(1);
    expect(matches[0].detector.id).toBe("cargo");
    expect(matches[0].patterns).toEqual(["a", "b"]);
  });

  it("returns no matches when the manifest doesn't declare a workspace", () => {
    expect(parseWorkspaceManifest("Cargo.toml", `[package]
name = "x"
`)).toEqual([]);
  });
});
