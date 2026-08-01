import { describe, expect, it } from "vitest";

import {
  applyWorkspaceContext,
  discoverMonorepoApps,
  discoverProjectRootHints,
  parseVercelRootDirectories,
  selectPreferredProjectRoot,
  selectPreferredSingleAppRoot,
} from "../../src/lib/project-root-detector";

describe("selectPreferredProjectRoot", () => {
  it("prefers a vercel-configured frontend directory over a root backend package", () => {
    const vercelConfig = JSON.stringify({
      installCommand: "npm install && cd frontend && npm install",
      buildCommand: "cd frontend && npm run build",
      outputDirectory: "frontend/dist",
    });
    expect(discoverProjectRootHints([
      { path: "api", type: "dir" },
      { path: "frontend", type: "dir" },
      { path: "package.json", type: "file" },
      { path: "server.js", type: "file" },
      { path: "vercel.json", type: "file" },
      { path: "frontend/package.json", type: "file" },
      { path: "frontend/vite.config.js", type: "file" },
    ], { "vercel.json": vercelConfig })).toContainEqual({
      rootDirectory: "frontend",
      source: "vercel",
    });

    const rootFiles = [
      { name: "api", type: "dir" as const },
      { name: "frontend", type: "dir" as const },
      { name: "package.json", type: "file" as const },
      { name: "server.js", type: "file" as const },
      { name: "vercel.json", type: "file" as const },
    ];

    const selected = selectPreferredProjectRoot(
      {
        rootDirectory: "",
        files: rootFiles,
        packageJson: {
          dependencies: { express: "^5.0.0" },
          scripts: { start: "node server.js" },
        },
        fileContents: { "vercel.json": vercelConfig },
      },
      [{
        rootDirectory: "frontend",
        source: "vercel",
        files: [
          { name: "package.json", type: "file" as const },
          { name: "src", type: "dir" as const },
          { name: "vite.config.js", type: "file" as const },
        ],
        packageJson: {
          dependencies: {
            react: "^19.0.0",
            "react-dom": "^19.0.0",
            vite: "^8.0.0",
          },
          scripts: { build: "vite build" },
        },
        fileContents: {},
      }],
    );

    expect(selected.rootDirectory).toBe("frontend");
    expect(selected.stack.stack).toBe("vite");
    expect(selected.stack.buildCommand).toBe("npm run build");
  });

  it("keeps the root when the root project is already fullstack", () => {
    const selected = selectPreferredProjectRoot(
      {
        rootDirectory: "",
        files: [
          { name: "package.json", type: "file" as const },
          { name: "next.config.js", type: "file" as const },
          { name: "src", type: "dir" as const },
        ],
        packageJson: {
          dependencies: {
            next: "^15.0.0",
            react: "^19.0.0",
            "react-dom": "^19.0.0",
          },
          scripts: { build: "next build", start: "next start" },
        },
        fileContents: {},
      },
      [{
        rootDirectory: "frontend",
        source: "discovered",
        files: [
          { name: "package.json", type: "file" as const },
          { name: "src", type: "dir" as const },
          { name: "vite.config.js", type: "file" as const },
        ],
        packageJson: {
          dependencies: {
            react: "^19.0.0",
            "react-dom": "^19.0.0",
            vite: "^8.0.0",
          },
          scripts: { build: "vite build" },
        },
        fileContents: {},
      }],
    );

    expect(selected.rootDirectory).toBe("");
    expect(selected.stack.stack).toBe("nextjs");
  });

  it("keeps a root compose project as the primary root and exposes the vercel frontend as a single-app alternative", () => {
    const vercelConfig = JSON.stringify({
      buildCommand: "cd frontend && npm run build",
      outputDirectory: "frontend/dist",
    });

    const rootInput = {
      rootDirectory: "",
      files: [
        { name: "docker-compose.yml", type: "file" as const },
        { name: "frontend", type: "dir" as const },
        { name: "vercel.json", type: "file" as const },
      ],
      fileContents: { "vercel.json": vercelConfig },
    };

    const frontendCandidate = {
      rootDirectory: "frontend",
      source: "vercel" as const,
      files: [
        { name: "package.json", type: "file" as const },
        { name: "src", type: "dir" as const },
        { name: "vite.config.ts", type: "file" as const },
      ],
      packageJson: {
        dependencies: {
          react: "^19.0.0",
          "react-dom": "^19.0.0",
          vite: "^8.0.0",
        },
        scripts: { build: "vite build" },
      },
      fileContents: {},
    };

    // Primary root remains the compose project - services pipeline owns the deploy.
    const primary = selectPreferredProjectRoot(rootInput, [frontendCandidate]);
    expect(primary.rootDirectory).toBe("");
    expect(primary.stack.projectType).toBe("services");

    // Single-app pipeline can promote the vercel-pointed frontend without mixing logic.
    const singleApp = selectPreferredSingleAppRoot(rootInput, [frontendCandidate]);
    expect(singleApp?.rootDirectory).toBe("frontend");
    expect(singleApp?.stack.stack).toBe("vite");
  });

  it("prefers an app workspace over a package library in a recursive repo tree", () => {
    const hints = discoverProjectRootHints(
      [
        { path: "package.json", type: "file" },
        { path: "pnpm-workspace.yaml", type: "file" },
        { path: "apps/web/package.json", type: "file" },
        { path: "apps/web/vite.config.ts", type: "file" },
        { path: "packages/ui/package.json", type: "file" },
        { path: "packages/ui/vite.config.ts", type: "file" },
      ],
      { "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  - 'packages/*'\n" },
      { packageManager: "pnpm@9.0.0" },
    );

    expect(hints[0]).toEqual({ rootDirectory: "apps/web", source: "workspace" });

    const selected = selectPreferredProjectRoot(
      {
        rootDirectory: "",
        files: [
          { name: "package.json", type: "file" as const },
          { name: "pnpm-workspace.yaml", type: "file" as const },
          { name: "apps", type: "dir" as const },
          { name: "packages", type: "dir" as const },
        ],
        packageJson: { packageManager: "pnpm@9.0.0" },
        fileContents: { "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  - 'packages/*'\n" },
      },
      [
        {
          rootDirectory: "packages/ui",
          source: "workspace",
          files: [
            { name: "package.json", type: "file" as const },
            { name: "src", type: "dir" as const },
            { name: "vite.config.ts", type: "file" as const },
          ],
          packageJson: {
            private: true,
            dependencies: {
              react: "^19.0.0",
              vite: "^8.0.0",
            },
            scripts: { build: "vite build" },
          },
          fileContents: {},
        },
        {
          rootDirectory: "apps/web",
          source: "workspace",
          files: [
            { name: "package.json", type: "file" as const },
            { name: "src", type: "dir" as const },
            { name: "public", type: "dir" as const },
            { name: "index.html", type: "file" as const },
            { name: "vite.config.ts", type: "file" as const },
          ],
          packageJson: {
            private: true,
            dependencies: {
              react: "^19.0.0",
              "react-dom": "^19.0.0",
              vite: "^8.0.0",
            },
            scripts: { build: "vite build" },
          },
          fileContents: {},
        },
      ],
    );

    expect(selected.rootDirectory).toBe("apps/web");
  });

  it("uses root workspace package manager and installs from repo root for nested apps", () => {
    const selected = applyWorkspaceContext(
      {
        rootDirectory: "",
        files: [
          { name: "package.json", type: "file" as const },
          { name: "pnpm-workspace.yaml", type: "file" as const },
          { name: "pnpm-lock.yaml", type: "file" as const },
        ],
        packageJson: {
          packageManager: "pnpm@9.0.0",
          workspaces: ["apps/*"],
        },
        fileContents: { "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n" },
      },
      selectPreferredProjectRoot(
        {
          rootDirectory: "",
          files: [
            { name: "package.json", type: "file" as const },
            { name: "pnpm-workspace.yaml", type: "file" as const },
            { name: "pnpm-lock.yaml", type: "file" as const },
          ],
          packageJson: {
            packageManager: "pnpm@9.0.0",
            workspaces: ["apps/*"],
          },
          fileContents: { "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n" },
        },
        [{
          rootDirectory: "apps/web",
          source: "workspace",
          files: [
            { name: "package.json", type: "file" as const },
            { name: "src", type: "dir" as const },
            { name: "vite.config.ts", type: "file" as const },
          ],
          packageJson: {
            name: "web",
            dependencies: {
              react: "^19.0.0",
              "react-dom": "^19.0.0",
              vite: "^8.0.0",
            },
            scripts: { build: "vite build" },
          },
          fileContents: {},
        }],
      ),
    );

    expect(selected.stack.packageManager).toBe("pnpm");
    expect(selected.stack.installCommand).toBe("cd ../.. && pnpm install");
    expect(selected.stack.buildCommand).toBe("pnpm build");
  });

  it("discovers and selects nested compose roots from a workspace tree", () => {
    const hints = discoverProjectRootHints(
      [
        { path: "package.json", type: "file" },
        { path: "pnpm-workspace.yaml", type: "file" },
        { path: "apps/services/compose.yml", type: "file" },
      ],
      { "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n" },
      { workspaces: ["apps/*"] },
    );

    expect(hints).toContainEqual({ rootDirectory: "apps/services", source: "workspace" });

    const selected = selectPreferredProjectRoot(
      {
        rootDirectory: "",
        files: [
          { name: "package.json", type: "file" as const },
        ],
        packageJson: {
          dependencies: { express: "^5.0.0" },
          scripts: { start: "node server.js" },
          workspaces: ["apps/*"],
        },
        fileContents: { "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n" },
      },
      [{
        rootDirectory: "apps/services",
        source: "workspace",
        files: [{ name: "compose.yml", type: "file" as const }],
        fileContents: {},
      }],
    );

    expect(selected.rootDirectory).toBe("apps/services");
    expect(selected.stack.stack).toBe("docker-compose");
  });

  it("recognises a Rush monorepo and elevates its projects to workspace hints", () => {
    const rushJson = JSON.stringify({
      projects: [
        { packageName: "@app/web", projectFolder: "apps/web" },
        { packageName: "@app/api", projectFolder: "services/api" },
      ],
    });

    const hints = discoverProjectRootHints(
      [
        { path: "rush.json", type: "file" },
        { path: "apps/web/package.json", type: "file" },
        { path: "services/api/package.json", type: "file" },
      ],
      { "rush.json": rushJson },
    );

    expect(hints).toContainEqual({ rootDirectory: "apps/web", source: "workspace" });
    expect(hints).toContainEqual({ rootDirectory: "services/api", source: "workspace" });
  });

  it("recognises an Nx project.json as a discovered project root", () => {
    const hints = discoverProjectRootHints([
      { path: "nx.json", type: "file" },
      { path: "apps/web/project.json", type: "file" },
    ]);

    expect(hints).toContainEqual({ rootDirectory: "apps/web", source: "discovered" });
  });
});

// ─── Workspace-format coverage ───────────────────────────────────────────────

describe("discoverProjectRootHints - workspace formats", () => {
  it("npm/yarn workspaces array form (package.json.workspaces=[\"apps/*\"])", () => {
    const hints = discoverProjectRootHints(
      [
        { path: "package.json", type: "file" },
        { path: "apps/web/package.json", type: "file" },
        { path: "apps/api/package.json", type: "file" },
      ],
      undefined,
      { workspaces: ["apps/*"] },
    );

    expect(hints).toContainEqual({ rootDirectory: "apps/web", source: "workspace" });
    expect(hints).toContainEqual({ rootDirectory: "apps/api", source: "workspace" });
  });

  it("yarn workspaces object form (package.json.workspaces.packages=[...])", () => {
    const hints = discoverProjectRootHints(
      [
        { path: "package.json", type: "file" },
        { path: "packages/ui/package.json", type: "file" },
      ],
      undefined,
      { workspaces: { packages: ["packages/*"], nohoist: ["**/react"] } },
    );

    expect(hints).toContainEqual({ rootDirectory: "packages/ui", source: "workspace" });
  });

  it("pnpm-workspace.yaml with both apps/* and packages/* patterns", () => {
    const hints = discoverProjectRootHints(
      [
        { path: "pnpm-workspace.yaml", type: "file" },
        { path: "apps/web/package.json", type: "file" },
        { path: "packages/utils/package.json", type: "file" },
      ],
      { "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  - 'packages/*'\n" },
    );

    expect(hints).toContainEqual({ rootDirectory: "apps/web", source: "workspace" });
    expect(hints).toContainEqual({ rootDirectory: "packages/utils", source: "workspace" });
  });

  it("pnpm-workspace.yaml with deep ** patterns", () => {
    const hints = discoverProjectRootHints(
      [
        { path: "pnpm-workspace.yaml", type: "file" },
        { path: "products/billing/api/package.json", type: "file" },
        { path: "products/identity/web/package.json", type: "file" },
      ],
      { "pnpm-workspace.yaml": "packages:\n  - 'products/**'\n" },
    );

    expect(hints).toContainEqual({ rootDirectory: "products/billing/api", source: "workspace" });
    expect(hints).toContainEqual({ rootDirectory: "products/identity/web", source: "workspace" });
  });

  it("turborepo: pnpm-workspace + turbo.json - workspace hints come from pnpm config", () => {
    // turbo.json itself is not parsed for workspaces - turbo relies on
    // package.json workspaces / pnpm-workspace. Verifying the hints flow.
    const hints = discoverProjectRootHints(
      [
        { path: "package.json", type: "file" },
        { path: "pnpm-workspace.yaml", type: "file" },
        { path: "turbo.json", type: "file" },
        { path: "apps/web/package.json", type: "file" },
        { path: "apps/docs/package.json", type: "file" },
        { path: "packages/ui/package.json", type: "file" },
      ],
      { "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  - 'packages/*'\n" },
    );

    expect(hints).toContainEqual({ rootDirectory: "apps/web", source: "workspace" });
    expect(hints).toContainEqual({ rootDirectory: "apps/docs", source: "workspace" });
    expect(hints).toContainEqual({ rootDirectory: "packages/ui", source: "workspace" });
  });
});

// ─── Hint discovery for non-JS roots ─────────────────────────────────────────

describe("discoverProjectRootHints - non-JS stacks", () => {
  it("discovers a nested Python app via requirements.txt", () => {
    const hints = discoverProjectRootHints([
      { path: "package.json", type: "file" },
      { path: "services/worker/requirements.txt", type: "file" },
    ]);
    expect(hints).toContainEqual({ rootDirectory: "services/worker", source: "discovered" });
  });

  it("discovers a nested Go app via go.mod", () => {
    const hints = discoverProjectRootHints([
      { path: "api/go.mod", type: "file" },
      { path: "api/main.go", type: "file" },
    ]);
    expect(hints).toContainEqual({ rootDirectory: "api", source: "discovered" });
  });

  it("discovers a nested Rust app via Cargo.toml", () => {
    const hints = discoverProjectRootHints([
      { path: "services/engine/Cargo.toml", type: "file" },
    ]);
    expect(hints).toContainEqual({ rootDirectory: "services/engine", source: "discovered" });
  });

  it("discovers a nested Rails app via Gemfile", () => {
    const hints = discoverProjectRootHints([
      { path: "apps/web/Gemfile", type: "file" },
      { path: "apps/web/config/routes.rb", type: "file" },
    ]);
    expect(hints).toContainEqual({ rootDirectory: "apps/web", source: "discovered" });
  });

  it("discovers a nested Django via manage.py", () => {
    const hints = discoverProjectRootHints([
      { path: "backend/manage.py", type: "file" },
    ]);
    expect(hints).toContainEqual({ rootDirectory: "backend", source: "discovered" });
  });

  it("discovers a nested static site via index.html", () => {
    const hints = discoverProjectRootHints([
      { path: "marketing/index.html", type: "file" },
      { path: "marketing/style.css", type: "file" },
    ]);
    expect(hints).toContainEqual({ rootDirectory: "marketing", source: "discovered" });
  });

  it("discovers a nested Dockerfile-based service", () => {
    const hints = discoverProjectRootHints([
      { path: "services/worker/Dockerfile", type: "file" },
    ]);
    expect(hints).toContainEqual({ rootDirectory: "services/worker", source: "discovered" });
  });
});

// ─── Ignored-directory hygiene ───────────────────────────────────────────────

describe("discoverProjectRootHints - ignored directories", () => {
  it("skips package.json files inside node_modules", () => {
    const hints = discoverProjectRootHints([
      { path: "package.json", type: "file" },
      { path: "node_modules/lodash/package.json", type: "file" },
      { path: "node_modules/.pnpm/some-pkg/node_modules/foo/package.json", type: "file" },
    ]);
    expect(hints.some((h) => h.rootDirectory.includes("node_modules"))).toBe(false);
  });

  it("skips entries inside .git, .next, .turbo, dist, build, target, out", () => {
    const hints = discoverProjectRootHints([
      { path: ".next/server/package.json", type: "file" },
      { path: ".turbo/cache/package.json", type: "file" },
      { path: "build/package.json", type: "file" },
      { path: "dist/manifest.json", type: "file" },
      { path: "out/index.html", type: "file" },
      { path: "target/debug/package.json", type: "file" },
    ]);
    expect(hints).toEqual([]);
  });

  it("skips entries inside .venv and __pycache__", () => {
    const hints = discoverProjectRootHints([
      { path: ".venv/lib/python3.12/site-packages/foo/pyproject.toml", type: "file" },
      { path: "__pycache__/something/requirements.txt", type: "file" },
    ]);
    expect(hints).toEqual([]);
  });

  it("does not include the root itself ('.' dirname) as a hint", () => {
    // A top-level next.config.js has dirname "." → normalized to "" → skipped.
    const hints = discoverProjectRootHints([
      { path: "next.config.js", type: "file" },
    ]);
    expect(hints.every((h) => h.rootDirectory !== "")).toBe(true);
  });
});

// ─── Vercel.json parsing edge cases ──────────────────────────────────────────

describe("parseVercelRootDirectories", () => {
  it("extracts directory from buildCommand 'cd <dir> && npm run build'", () => {
    expect(parseVercelRootDirectories(JSON.stringify({
      buildCommand: "cd frontend && npm run build",
    }))).toContain("frontend");
  });

  it("extracts directory from outputDirectory parent", () => {
    expect(parseVercelRootDirectories(JSON.stringify({
      outputDirectory: "apps/web/dist",
    }))).toContain("apps/web");
  });

  it("rejects '..' escape attempts", () => {
    expect(parseVercelRootDirectories(JSON.stringify({
      buildCommand: "cd ../sibling && npm run build",
    }))).not.toContain("..");
    expect(parseVercelRootDirectories(JSON.stringify({
      buildCommand: "cd .. && npm run build",
    }))).toEqual([]);
  });

  it("rejects ignored dir candidates (node_modules, .next, etc.)", () => {
    expect(parseVercelRootDirectories(JSON.stringify({
      buildCommand: "cd node_modules/whatever && npm run build",
    }))).toEqual([]);
  });

  it("ignores 'dist' as an outputDirectory (dirname is '.', no useful hint)", () => {
    // When outputDirectory is a bare filename like "dist", dirname() returns "."
    // which doesn't point at any subdirectory - discard.
    expect(parseVercelRootDirectories(JSON.stringify({
      outputDirectory: "dist",
    }))).toEqual([]);
  });

  it("returns empty for invalid JSON", () => {
    expect(parseVercelRootDirectories("{not json")).toEqual([]);
  });

  it("returns empty for empty input", () => {
    expect(parseVercelRootDirectories(undefined)).toEqual([]);
    expect(parseVercelRootDirectories("")).toEqual([]);
  });

  it("handles multiple cd-into-dir patterns in one buildCommand", () => {
    const dirs = parseVercelRootDirectories(JSON.stringify({
      buildCommand: "cd packages/ui && npm run build && cd apps/web && npm run build",
    }));
    expect(dirs).toContain("packages/ui");
    expect(dirs).toContain("apps/web");
  });
});

// ─── Selector behavior - single-app vs services dual mode ────────────────────

describe("selectPreferredProjectRoot - single-app monorepo scenarios", () => {
  it("promotes apps/web in a pnpm monorepo with a backend root", () => {
    const root = {
      rootDirectory: "",
      files: [
        { name: "package.json", type: "file" as const },
        { name: "pnpm-workspace.yaml", type: "file" as const },
      ],
      packageJson: {
        dependencies: { express: "^5.0.0" },
        scripts: { start: "node server.js" },
      },
      fileContents: { "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  - 'packages/*'\n" },
    };
    const candidate = {
      rootDirectory: "apps/web",
      source: "workspace" as const,
      files: [
        { name: "package.json", type: "file" as const },
        { name: "next.config.js", type: "file" as const },
        { name: "src", type: "dir" as const },
      ],
      packageJson: {
        dependencies: { next: "^15.0.0", react: "^19.0.0" },
        scripts: { build: "next build", start: "next start" },
      },
      fileContents: {},
    };

    const selected = selectPreferredProjectRoot(root, [candidate]);
    expect(selected.rootDirectory).toBe("apps/web");
    expect(selected.stack.stack).toBe("nextjs");
  });

  it("keeps root when root is already a fullstack app (Next.js) even with workspace apps below", () => {
    const root = {
      rootDirectory: "",
      files: [
        { name: "package.json", type: "file" as const },
        { name: "next.config.js", type: "file" as const },
        { name: "apps", type: "dir" as const },
      ],
      packageJson: {
        dependencies: { next: "^15.0.0", react: "^19.0.0" },
        scripts: { build: "next build", start: "next start" },
        workspaces: ["apps/*"],
      },
      fileContents: {},
    };
    const nestedApp = {
      rootDirectory: "apps/web",
      source: "workspace" as const,
      files: [
        { name: "package.json", type: "file" as const },
        { name: "vite.config.ts", type: "file" as const },
      ],
      packageJson: {
        dependencies: { vite: "^5.0.0", react: "^19.0.0" },
        scripts: { build: "vite build" },
      },
      fileContents: {},
    };

    const selected = selectPreferredProjectRoot(root, [nestedApp]);
    expect(selected.rootDirectory).toBe("");
    expect(selected.stack.stack).toBe("nextjs");
  });

  it("picks the highest-scored app among multiple workspace candidates", () => {
    // Two apps: one with build script + public/, one without. The one with
    // production signals should win via scoreCandidate.
    const root = {
      rootDirectory: "",
      files: [
        { name: "package.json", type: "file" as const },
        { name: "pnpm-workspace.yaml", type: "file" as const },
      ],
      packageJson: { workspaces: ["apps/*"] },
      fileContents: { "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n" },
    };

    const winner = {
      rootDirectory: "apps/web",
      source: "workspace" as const,
      files: [
        { name: "package.json", type: "file" as const },
        { name: "next.config.js", type: "file" as const },
        { name: "public", type: "dir" as const },
        { name: "src", type: "dir" as const },
        { name: "index.html", type: "file" as const },
      ],
      packageJson: {
        dependencies: { next: "^15.0.0" },
        scripts: { build: "next build" },
      },
      fileContents: {},
    };

    const loser = {
      rootDirectory: "apps/internal",
      source: "workspace" as const,
      files: [{ name: "package.json", type: "file" as const }],
      packageJson: {
        dependencies: { express: "^5.0.0" },
        // No build script, no production indicators.
      },
      fileContents: {},
    };

    const selected = selectPreferredProjectRoot(root, [loser, winner]);
    expect(selected.rootDirectory).toBe("apps/web");
  });
});

describe("selectPreferredSingleAppRoot - services-with-app dual mode", () => {
  it("returns null when root is not a services project", () => {
    const root = {
      rootDirectory: "",
      files: [
        { name: "package.json", type: "file" as const },
        { name: "next.config.js", type: "file" as const },
      ],
      packageJson: { dependencies: { next: "^15.0.0" } },
      fileContents: {},
    };
    const candidate = {
      rootDirectory: "apps/admin",
      source: "workspace" as const,
      files: [{ name: "package.json", type: "file" as const }, { name: "vite.config.ts", type: "file" as const }],
      packageJson: { dependencies: { vite: "^5.0.0", react: "^19.0.0" } },
      fileContents: {},
    };
    expect(selectPreferredSingleAppRoot(root, [candidate])).toBeNull();
  });

  it("returns the nested vite app when root is docker-compose", () => {
    const root = {
      rootDirectory: "",
      files: [
        { name: "docker-compose.yml", type: "file" as const },
        { name: "apps", type: "dir" as const },
      ],
      fileContents: {},
    };
    const candidate = {
      rootDirectory: "apps/web",
      source: "discovered" as const,
      files: [{ name: "package.json", type: "file" as const }, { name: "vite.config.ts", type: "file" as const }],
      packageJson: { dependencies: { vite: "^5.0.0", react: "^19.0.0" } },
      fileContents: {},
    };
    const result = selectPreferredSingleAppRoot(root, [candidate]);
    expect(result?.rootDirectory).toBe("apps/web");
    expect(result?.stack.stack).toBe("vite");
  });
});

describe("applyWorkspaceContext - install command rewriting", () => {
  it("rewrites pnpm install with the right depth (apps/web → ../..)", () => {
    const adjusted = applyWorkspaceContext(
      {
        rootDirectory: "",
        files: [
          { name: "package.json", type: "file" as const },
          { name: "pnpm-workspace.yaml", type: "file" as const },
          { name: "pnpm-lock.yaml", type: "file" as const },
        ],
        packageJson: {
          packageManager: "pnpm@9.0.0",
          workspaces: ["apps/*"],
        },
        fileContents: { "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n" },
      },
      selectPreferredProjectRoot(
        {
          rootDirectory: "",
          files: [
            { name: "package.json", type: "file" as const },
            { name: "pnpm-workspace.yaml", type: "file" as const },
            { name: "pnpm-lock.yaml", type: "file" as const },
          ],
          packageJson: { packageManager: "pnpm@9.0.0", workspaces: ["apps/*"] },
          fileContents: { "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n" },
        },
        [
          {
            rootDirectory: "apps/web",
            source: "workspace" as const,
            files: [
              { name: "package.json", type: "file" as const },
              { name: "next.config.js", type: "file" as const },
            ],
            packageJson: {
              name: "web",
              dependencies: { next: "^15.0.0" },
              scripts: { build: "next build", start: "next start" },
            },
            fileContents: {},
          },
        ],
      ),
    );

    expect(adjusted.stack.packageManager).toBe("pnpm");
    expect(adjusted.stack.installCommand).toBe("cd ../.. && pnpm install");
  });

  it("rewrites yarn install at a 3-deep nested workspace (products/web/admin → ../../..)", () => {
    const root = {
      rootDirectory: "",
      files: [
        { name: "package.json", type: "file" as const },
        { name: "yarn.lock", type: "file" as const },
      ],
      packageJson: { workspaces: ["products/**"] },
      fileContents: {},
    };

    const selectedRoot = selectPreferredProjectRoot(root, [
      {
        rootDirectory: "products/web/admin",
        source: "workspace" as const,
        files: [
          { name: "package.json", type: "file" as const },
          { name: "vite.config.ts", type: "file" as const },
        ],
        packageJson: {
          dependencies: { vite: "^5.0.0", react: "^19.0.0" },
          scripts: { build: "vite build" },
        },
        fileContents: {},
      },
    ]);

    const adjusted = applyWorkspaceContext(root, selectedRoot);
    expect(adjusted.stack.packageManager).toBe("yarn");
    expect(adjusted.stack.installCommand).toBe("cd ../../.. && yarn install");
  });

  it("does not rewrite when there is no workspace context", () => {
    const root = {
      rootDirectory: "",
      files: [{ name: "package.json", type: "file" as const }],
      packageJson: { dependencies: { next: "^15.0.0" } },
      fileContents: {},
    };

    const selectedRoot = selectPreferredProjectRoot(root, []);
    const adjusted = applyWorkspaceContext(root, selectedRoot);
    expect(adjusted.stack.installCommand).not.toContain("cd");
  });
});

// ─── Implicit (manifest-less) monorepo detection ─────────────────────────────

describe("discoverMonorepoApps - implicit monorepo (no workspace manifest)", () => {
  const ROOT_VERCEL = JSON.stringify({
    installCommand: "npm install && cd frontend && npm install",
    buildCommand: "cd frontend && npm run build",
    outputDirectory: "frontend/dist",
    rewrites: [{ source: "/(.*)", destination: "/index.html" }],
  });
  const FRONTEND_VERCEL = JSON.stringify({
    rewrites: [{ source: "/(.*)", destination: "/index.html" }],
  });

  const rootBackend = () => ({
    rootDirectory: "",
    files: [
      { name: "package.json", type: "file" as const },
      { name: "package-lock.json", type: "file" as const },
      { name: "server.js", type: "file" as const },
      { name: "vercel.json", type: "file" as const },
      { name: "render.yaml", type: "file" as const },
      { name: "frontend", type: "dir" as const },
    ],
    packageJson: {
      name: "api",
      dependencies: { express: "^5.0.0" },
      scripts: { start: "node server.js" },
    },
    fileContents: { "vercel.json": ROOT_VERCEL, "render.yaml": "services:\n  - type: web\n    startCommand: npm start\n" },
  });

  const frontendVite = (source: "vercel" | "discovered" = "vercel") => ({
    rootDirectory: "frontend",
    source,
    files: [
      { name: "package.json", type: "file" as const },
      { name: "package-lock.json", type: "file" as const },
      { name: "vite.config.js", type: "file" as const },
      { name: "index.html", type: "file" as const },
      { name: "src", type: "dir" as const },
      { name: "vercel.json", type: "file" as const },
    ],
    packageJson: {
      name: "frontend",
      dependencies: { react: "^19.0.0", "react-dom": "^19.0.0", vite: "^8.0.0" },
      scripts: { build: "vite build" },
    },
    fileContents: { "vercel.json": FRONTEND_VERCEL },
  });

  it("treats a root backend + independent nested frontend as a 2-app monorepo", () => {
    const result = discoverMonorepoApps(rootBackend(), [frontendVite()]);
    expect(result).not.toBeNull();
    expect(result!.apps).toHaveLength(2);

    const root = result!.apps[0];
    expect(root.rootDirectory).toBe(".");
    expect(root.stack).toBe("express");
    expect(root.category).toBe("backend");
    expect(root.startCommand).toContain("start"); // node server.js via npm start
    expect(root.name).toBe("api");

    const frontend = result!.apps[1];
    expect(frontend.rootDirectory).toBe("frontend");
    expect(frontend.stack).toBe("vite");
    expect(frontend.category).toBe("frontend");
    expect(frontend.buildCommand).toBe("npm run build");
    // Static sub-app has no start command - the monorepo pipeline serves its
    // build output as files via the generated nginx image (isStaticService).
    expect(frontend.startCommand).toBe("");
    expect(frontend.outputDirectory).toBe("dist");

    // Implicit monorepo has no shared root install.
    expect(result!.workspace.prepareCommand).toBe("");
  });

  it("counts a nested app as independent when it has its own lockfile (not just a bare package.json)", () => {
    // Same frontend but discovered (not vercel-sourced) - still independent via its own package-lock.json.
    const result = discoverMonorepoApps(rootBackend(), [frontendVite("discovered")]);
    expect(result).not.toBeNull();
    expect(result!.apps.map((a) => a.rootDirectory).sort()).toEqual([".", "frontend"]);
  });

  it("does NOT treat a plain app with a bare-package.json examples/ folder as a monorepo", () => {
    const root = {
      rootDirectory: "",
      files: [
        { name: "package.json", type: "file" as const },
        { name: "next.config.js", type: "file" as const },
        { name: "examples", type: "dir" as const },
      ],
      packageJson: {
        dependencies: { next: "^15.0.0", react: "^19.0.0" },
        scripts: { build: "next build", start: "next start" },
      },
      fileContents: {},
    };
    const examples = {
      rootDirectory: "examples",
      source: "discovered" as const,
      files: [{ name: "package.json", type: "file" as const }], // no lockfile, not vercel-sourced
      packageJson: { dependencies: { lodash: "^4.0.0" } },
      fileContents: {},
    };
    expect(discoverMonorepoApps(root, [examples])).toBeNull();
  });

  it("does NOT fire when the root is a services (compose) project", () => {
    const root = {
      rootDirectory: "",
      files: [
        { name: "docker-compose.yml", type: "file" as const },
        { name: "frontend", type: "dir" as const },
      ],
      fileContents: {},
    };
    expect(discoverMonorepoApps(root, [frontendVite()])).toBeNull();
  });
});

describe("discoverMonorepoApps - .NET class-library exclusion", () => {
  const WEB_CSPROJ =
    '<Project Sdk="Microsoft.NET.Sdk.Web">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n';
  const LIB_CSPROJ =
    '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n';

  // A deployable web app at the repo root (ASP.NET Core Web SDK).
  const rootWebApp = () => ({
    rootDirectory: "",
    files: [
      { name: "Crud.Demo.csproj", type: "file" as const },
      { name: "Program.cs", type: "file" as const },
    ],
    fileContents: { "crud.demo.csproj": WEB_CSPROJ },
  });

  const project = (dir: string, csproj: string) => ({
    rootDirectory: dir,
    source: "discovered" as const,
    files: [{ name: `${dir}.csproj`, type: "file" as const }],
    fileContents: { [`${dir.toLowerCase()}.csproj`]: csproj },
  });

  it("does not turn class libraries into apps - a web app + libraries is one app", () => {
    // The CRUD-Demo shape: one web project plus DataAccess/BusinessLogic class
    // libraries. Libraries are .dlls the web app links, not deployable apps, so
    // this must NOT become a 3-app monorepo (3 domains on port 5000).
    const result = discoverMonorepoApps(rootWebApp(), [
      project("DataAccess", LIB_CSPROJ),
      project("BusinessLogic", LIB_CSPROJ),
    ]);
    expect(result).toBeNull();
  });

  it("keeps deployable .NET projects while dropping libraries", () => {
    const result = discoverMonorepoApps(rootWebApp(), [
      project("ApiB", WEB_CSPROJ),
      project("SharedLib", LIB_CSPROJ),
    ]);
    expect(result).not.toBeNull();
    expect(result!.apps.map((app) => app.rootDirectory).sort()).toEqual([".", "ApiB"]);
  });
});

describe("discoverMonorepoApps - formal workspace monorepo with per-app Dockerfiles", () => {
  // Mirrors a Railway-style pnpm/turbo monorepo where every sub-app carries its
  // own Dockerfile (and often a railway.json) instead of being buildpack-
  // detected. Each sub-app's stack therefore resolves to "docker"
  // (projectType "docker"), not "app" - previously excluded entirely by
  // isMonorepoAppCandidate, which dropped candidates to 0 and made
  // discoverMonorepoApps return null for the whole repo.
  const root = () => ({
    rootDirectory: "",
    files: [
      { name: "package.json", type: "file" as const },
      { name: "pnpm-workspace.yaml", type: "file" as const },
      { name: "turbo.json", type: "file" as const },
      { name: "apps", type: "dir" as const },
    ],
    packageJson: { packageManager: "pnpm@9.0.0" },
    fileContents: { "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n" },
  });

  const dockerSubApp = (dir: string) => ({
    rootDirectory: dir,
    source: "workspace" as const,
    files: [
      { name: "package.json", type: "file" as const },
      { name: "Dockerfile", type: "file" as const },
      { name: "railway.json", type: "file" as const },
    ],
    packageJson: { name: dir.split("/").at(-1) },
    fileContents: {},
  });

  it("detects a monorepo whose sub-apps each have their own Dockerfile", () => {
    const result = discoverMonorepoApps(root(), [
      dockerSubApp("apps/api"),
      dockerSubApp("apps/saas"),
      dockerSubApp("apps/marketing"),
    ]);

    expect(result).not.toBeNull();
    expect(result!.apps.map((app) => app.rootDirectory).sort()).toEqual([
      "apps/api",
      "apps/marketing",
      "apps/saas",
    ]);
    for (const app of result!.apps) {
      expect(app.stack).toBe("docker");
      // The Dockerfile owns install/build/start - the runtime builds straight
      // from it (requireRepositoryDockerfile), so these stay empty rather than
      // being synthesized.
      expect(app.installCommand).toBe("");
      expect(app.buildCommand).toBe("");
      expect(app.startCommand).toBe("");
    }
    expect(result!.workspace.packageManager).toBe("pnpm");
  });

  it("still excludes a services (docker-compose) candidate from the app list", () => {
    const composeSubApp = {
      rootDirectory: "apps/infra",
      source: "workspace" as const,
      files: [{ name: "docker-compose.yml", type: "file" as const }],
      fileContents: {},
    };
    const result = discoverMonorepoApps(root(), [
      dockerSubApp("apps/api"),
      dockerSubApp("apps/saas"),
      composeSubApp,
    ]);
    expect(result).not.toBeNull();
    expect(result!.apps.map((app) => app.rootDirectory).sort()).toEqual(["apps/api", "apps/saas"]);
  });

  it("blanks a Dockerfile-owned sub-app's install command outside a hoisting workspace", () => {
    // The sibling assertion above passes for a free reason: a pnpm workspace
    // hoists install to the root, so applyWorkspaceContext already clears it.
    // With no workspace manifest there is no hoisting, and detectStack happily
    // emits "npm i --force" off the sub-app's package.json - a command the
    // Dockerfile branch never runs. Keyed on stack === "docker".
    const rootBackend = {
      rootDirectory: "",
      files: [
        { name: "package.json", type: "file" as const },
        { name: "package-lock.json", type: "file" as const },
        { name: "server.js", type: "file" as const },
        { name: "worker", type: "dir" as const },
      ],
      packageJson: {
        name: "api",
        dependencies: { express: "^5.0.0" },
        scripts: { start: "node server.js" },
      },
      fileContents: {},
    };
    const dockerWorker = {
      rootDirectory: "worker",
      source: "discovered" as const,
      files: [
        { name: "package.json", type: "file" as const },
        { name: "package-lock.json", type: "file" as const },
        { name: "Dockerfile", type: "file" as const },
      ],
      packageJson: { name: "worker" },
      fileContents: {},
    };

    const result = discoverMonorepoApps(rootBackend, [dockerWorker]);
    expect(result).not.toBeNull();
    const worker = result!.apps.find((app) => app.rootDirectory === "worker");
    expect(worker).toBeDefined();
    expect(worker!.stack).toBe("docker");
    expect(worker!.installCommand).toBe("");
    expect(worker!.buildCommand).toBe("");
    expect(worker!.startCommand).toBe("");
  });

  it("keeps real commands on a framework sub-app that merely ships a Dockerfile", () => {
    // The inverse guard. A Vite/Next app shipping an OPTIONAL Dockerfile still
    // detects as its framework, so the pipeline takes the buildpack branch
    // (`stack === "docker" || dockerfilePath`, see cloud.ts) - keying the blanking
    // on "a Dockerfile exists" instead of on the stack leaves it with nothing to
    // install, build, or start.
    const viteWithDockerfile = {
      rootDirectory: "frontend",
      source: "discovered" as const,
      files: [
        { name: "package.json", type: "file" as const },
        { name: "package-lock.json", type: "file" as const },
        { name: "vite.config.js", type: "file" as const },
        { name: "index.html", type: "file" as const },
        { name: "Dockerfile", type: "file" as const },
      ],
      packageJson: {
        name: "frontend",
        dependencies: { react: "^19.0.0", vite: "^8.0.0" },
        scripts: { build: "vite build" },
      },
      fileContents: {},
    };
    const rootBackend = {
      rootDirectory: "",
      files: [
        { name: "package.json", type: "file" as const },
        { name: "package-lock.json", type: "file" as const },
        { name: "server.js", type: "file" as const },
        { name: "frontend", type: "dir" as const },
      ],
      packageJson: {
        name: "api",
        dependencies: { express: "^5.0.0" },
        scripts: { start: "node server.js" },
      },
      fileContents: {},
    };

    const result = discoverMonorepoApps(rootBackend, [viteWithDockerfile]);
    expect(result).not.toBeNull();
    const frontend = result!.apps.find((app) => app.rootDirectory === "frontend");
    expect(frontend).toBeDefined();
    expect(frontend!.stack).toBe("vite");
    expect(frontend!.installCommand).not.toBe("");
    expect(frontend!.buildCommand).toBe("npm run build");
  });

  it("sanitizes an npm-scoped package.json name into a Docker-safe service name", () => {
    // pnpm/turborepo workspaces conventionally name sub-apps "@scope/pkg".
    // That name is persisted as Service.name and used verbatim as a Docker
    // container/network name downstream, which rejects "@" and "/" - this
    // was the exact shape of the Virtalio repo that surfaced the bug.
    const scopedSubApp = (dir: string, pkgName: string) => ({
      rootDirectory: dir,
      source: "workspace" as const,
      files: [
        { name: "package.json", type: "file" as const },
        { name: "Dockerfile", type: "file" as const },
      ],
      packageJson: { name: pkgName },
      fileContents: {},
    });

    const result = discoverMonorepoApps(root(), [
      scopedSubApp("apps/api", "@virtalio/api"),
      scopedSubApp("apps/saas", "@virtalio/saas"),
      scopedSubApp("apps/marketing", "@virtalio/marketing"),
    ]);

    expect(result).not.toBeNull();
    const names = result!.apps.map((app) => app.name).sort();
    expect(names).toEqual(["virtalio-api", "virtalio-marketing", "virtalio-saas"]);
    for (const name of names) {
      expect(name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
    }
  });
});