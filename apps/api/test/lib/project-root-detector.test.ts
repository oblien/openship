import { describe, expect, it } from "vitest";

import {
  applyWorkspaceContext,
  discoverProjectRootHints,
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

    // Primary root remains the compose project — services pipeline owns the deploy.
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