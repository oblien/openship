/**
 * The self-hosted-vs-cloud boundary for STATIC compose sub-apps.
 *
 * Self-hosted moves the build output to a host directory the edge serves; cloud has
 * no host directory (Oblien runs the workload) so it keeps the generated nginx image
 * and stays a proxied container. These assert the flags that decide which, because
 * getting it backwards is silent: cloud would extract to a path nothing serves, and
 * self-hosted would go back to running a redundant web server.
 */
import { describe, expect, it } from "vitest";
import {
  generateDockerfile,
  staticBuilderOutputPath,
} from "../../../../../packages/adapters/src/runtime/docker-build-plan";
import type { BuildConfig } from "@repo/adapters";

const cfg = (over: Partial<BuildConfig> = {}): BuildConfig =>
  ({
    sessionId: "sess1",
    projectId: "proj1",
    slug: "web",
    stack: "vite",
    buildImage: "node:22",
    rootDirectory: "apps/web",
    outputDirectory: "dist",
    port: 3000,
    envVars: {},
    resources: { cpu: 1, memory: 512 },
    ...over,
  }) as BuildConfig;

describe("compose static sub-app — self-hosted (extract to host)", () => {
  const df = generateDockerfile(cfg({ isStatic: true, staticExtractOnly: true }));

  it("builds no web server: the edge already serves the files", () => {
    expect(df).not.toContain("nginx");
    expect(df).not.toContain("CMD");
    expect(df.match(/^FROM /gm)).toHaveLength(1);
  });

  it("puts the output where the extractor will look for it", () => {
    expect(staticBuilderOutputPath(cfg({ isStatic: true, staticExtractOnly: true }))).toBe(
      "/workspace/apps/web/dist",
    );
  });
});

describe("compose static sub-app — cloud (served container)", () => {
  // No staticExtractOnly: this is what the cloud runtime gets.
  const df = generateDockerfile(cfg({ isStatic: true }));

  it("keeps the nginx runtime so Oblien has something to run", () => {
    expect(df).toContain("FROM nginx:alpine");
    expect(df).toContain('CMD ["nginx", "-g", "daemon off;"]');
    expect(df).toContain("COPY --from=builder /workspace/apps/web/dist /usr/share/nginx/html");
  });

  it("serves on the configured container port with SPA fallback", () => {
    expect(df).toContain("listen 3000 default_server;");
    expect(df).toContain("try_files $uri $uri/ /index.html;");
  });
});

describe("a server sub-app is unaffected by either path", () => {
  it("runs its start command and never touches the static branch", () => {
    const df = generateDockerfile(cfg({ isStatic: false, startCommand: "node server.js" }));
    expect(df).not.toContain("nginx");
    expect(df).toContain('CMD ["sh", "-c", "node server.js"]');
  });
});
