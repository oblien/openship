import type { BuildConfig } from "../../types";
import { normalizeDockerRootDirectory } from "../docker-paths";
import {
  builderSourceDir,
  normalizeRelativePath,
  buildEnvPrefix,
  workspacePrepareRunLine,
  installBuildRunLine,
  nodeBinPathEnvLine,
} from "./shared";

// nginx server block for a static SPA build. `listen` is baked at build time
// (the port is known); nginx's own $uri is written literally.
function staticNginxTemplateLines(port: number): string[] {
  return [
    "server {",
    `    listen ${port} default_server;`,
    "    root /usr/share/nginx/html;",
    "    index index.html;",
    "    location / { try_files $uri $uri/ /index.html; }",
    "}",
  ];
}

/**
 * Where the built files land INSIDE the builder stage.
 *
 * Exported because the extract-only path has to read exactly the directory the
 * recipe wrote. Deriving it twice is how the extractor silently ends up copying an
 * empty or wrong dir when `rootDirectory` / `outputDirectory` handling shifts, so
 * both the Dockerfile and `buildStaticToHost` call this.
 */
/**
 * The builder stage's WORKDIR — the directory `COPY . /workspace` lands the build
 * context in, offset by `rootDirectory` for a monorepo sub-app.
 *
 * Exported so the static extractor can ask the one question it cannot answer
 * locally: is this project's doc-root the same directory as its build context? It
 * is exactly when `outputDirectory` is empty or ".", and that is the case where
 * the context's own build files (`.dockerignore`, the generated Dockerfile) would
 * otherwise be published as site content.
 */
export function builderContextRoot(config: BuildConfig): string {
  return builderSourceDir(normalizeDockerRootDirectory(config.rootDirectory, config.localPath));
}

/**
 * Is this a TOP-LEVEL doc-root entry that is a build input rather than content?
 *
 * `Dockerfile.*` covers both the single-app generated name (`Dockerfile.openship`)
 * and the compose batch builder's per-service one
 * (`Dockerfile.openship.<sessionId>`), plus a repo's own `Dockerfile.prod`.
 */
export function isExcludedDocRootEntry(name: string): boolean {
  return (
    name === ".dockerignore" ||
    name === ".git" ||
    name === "Dockerfile" ||
    name.startsWith("Dockerfile.")
  );
}

export function staticBuilderOutputPath(config: BuildConfig): string {
  const sourceDir = builderSourceDir(
    normalizeDockerRootDirectory(config.rootDirectory, config.localPath),
  );
  const output = normalizeRelativePath(config.outputDirectory);
  return output ? `${sourceDir}/${output}` : sourceDir;
}

/**
 * Static build → served as files by a minimal nginx image with SPA fallback,
 * matching how Vercel serves a static output directory. A builder stage runs the
 * app's install+build (and any monorepo workspace prepare), then the built
 * `outputDirectory` is copied into `nginx:alpine`. No runtime dependency fetch.
 */
export function generateStaticDockerfile(config: BuildConfig): string {
  const sourceDir = builderSourceDir(
    normalizeDockerRootDirectory(config.rootDirectory, config.localPath),
  );
  const envPrefix = buildEnvPrefix(config.envVars);
  const workspacePrepare = config.workspacePrepareCommand?.trim();
  const outputPath = staticBuilderOutputPath(config);
  const nginxTemplate = staticNginxTemplateLines(config.port)
    .map((line) => `'${line}'`)
    .join(" ");

  const lines: string[] = [`FROM ${config.buildImage} AS builder`];
  const buildBinPath = nodeBinPathEnvLine(config.packageManager, [sourceDir, "/workspace"]);
  if (buildBinPath) lines.push(buildBinPath);
  lines.push(`WORKDIR /workspace`, `COPY . /workspace`);
  if (workspacePrepare) {
    lines.push(workspacePrepareRunLine(config, envPrefix, workspacePrepare));
  }
  lines.push(`WORKDIR ${sourceDir}`);
  const stepsLine = installBuildRunLine(config, envPrefix);
  if (stepsLine) lines.push(stepsLine);

  // Extract-only: the caller lifts the built files out and deletes the image, so
  // the recipe STOPS at the builder. No second base image is pulled and nothing is
  // copied twice — the extractor reads `staticBuilderOutputPath(config)` (this same
  // `outputPath`) straight out of the builder. The nginx stage, its six steps, and
  // a server config nothing ever reads were all discarded work on every deploy.
  if (config.staticExtractOnly) return lines.join("\n");

  lines.push(
    `FROM nginx:alpine AS runtime`,
    `RUN rm -f /etc/nginx/conf.d/default.conf`,
    `COPY --from=builder ${outputPath} /usr/share/nginx/html`,
    `RUN printf '%s\\n' ${nginxTemplate} > /etc/nginx/conf.d/app.conf`,
    `EXPOSE ${config.port}`,
    `CMD ["nginx", "-g", "daemon off;"]`,
  );

  return lines.join("\n");
}
