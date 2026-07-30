import { describe, expect, it } from "vitest";

import { generateDockerfile, staticBuilderOutputPath } from "../src/runtime/docker-build-plan";
import type { BuildConfig } from "../src/types";

function baseConfig(overrides: Partial<BuildConfig> = {}): BuildConfig {
  return {
    sessionId: "s1",
    projectId: "p1",
    repoUrl: "https://github.com/acme/app.git",
    branch: "main",
    stack: "vite",
    buildImage: "node:22",
    runtimeImage: "node:22",
    packageManager: "npm",
    installCommand: "npm ci",
    buildCommand: "npm run build",
    outputDirectory: "dist",
    port: 8080,
    envVars: {},
    resources: { cpuCores: 1, memoryMb: 512, diskMb: 1024 },
    ...overrides,
  };
}

describe("generateDockerfile - static branch", () => {
  it("serves the output dir from nginx with SPA fallback on the configured port", () => {
    const df = generateDockerfile(baseConfig({ isStatic: true, rootDirectory: "frontend", port: 8080 }));
    expect(df).toContain("FROM node:22 AS builder");
    expect(df).toContain("RUN"); // install+build step
    expect(df).toContain("FROM nginx:alpine");
    expect(df).toContain("COPY --from=builder /workspace/frontend/dist /usr/share/nginx/html");
    expect(df).toContain("listen 8080 default_server;");
    expect(df).toContain("try_files $uri $uri/ /index.html;");
    expect(df).toContain('CMD ["nginx", "-g", "daemon off;"]');
  });

  it("serves from the repo root when rootDirectory is '.'", () => {
    const df = generateDockerfile(baseConfig({ isStatic: true, rootDirectory: ".", outputDirectory: "docs" }));
    expect(df).toContain("COPY --from=builder /workspace/docs /usr/share/nginx/html");
  });

  it("a non-static (server) sub-app does NOT use the static branch", () => {
    const df = generateDockerfile(baseConfig({ isStatic: false, startCommand: "node server.js" }));
    expect(df).not.toContain("nginx:alpine");
    expect(df).toContain('CMD ["sh", "-c", "node server.js"]');
  });
});

describe("generateDockerfile - static EXTRACT-ONLY (edge serves the files)", () => {
  it("stops at the builder: no runtime image, no second base pull", () => {
    const df = generateDockerfile(
      baseConfig({ isStatic: true, staticExtractOnly: true, rootDirectory: "frontend" }),
    );
    expect(df).toContain("FROM node:22 AS builder");
    // The whole point: the edge already serves these files, so no web server is
    // built. A second FROM here means we're pulling + discarding an image again.
    expect(df).not.toContain("nginx:alpine");
    expect(df).not.toContain("/usr/share/nginx/html");
    expect(df).not.toContain("CMD");
    expect(df.match(/^FROM /gm)).toHaveLength(1);
  });

  it("does not copy the output a second time inside the image", () => {
    const df = generateDockerfile(
      baseConfig({ isStatic: true, staticExtractOnly: true, rootDirectory: "frontend" }),
    );
    // Extraction reads the builder's own dist dir; staging it elsewhere would
    // duplicate the whole output into another layer for nothing.
    expect(df).not.toContain("/openship-static");
    expect(df).not.toMatch(/cp -a .*dist/);
  });

  it("the extractor and the recipe agree on where the files are", () => {
    const cfg = baseConfig({
      isStatic: true,
      staticExtractOnly: true,
      rootDirectory: "frontend",
      outputDirectory: "build",
    });
    // buildStaticToHost extracts from exactly this path — one helper, so the two
    // cannot drift into copying an empty directory.
    expect(staticBuilderOutputPath(cfg)).toBe("/workspace/frontend/build");
  });

  it("a compose static sub-app STILL gets the nginx runtime (it is run, not extracted)", () => {
    const df = generateDockerfile(baseConfig({ isStatic: true, rootDirectory: "frontend" }));
    expect(df).toContain("FROM nginx:alpine");
    expect(df).toContain('CMD ["nginx", "-g", "daemon off;"]');
  });
});
