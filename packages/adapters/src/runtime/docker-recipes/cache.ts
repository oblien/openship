import { createHash } from "node:crypto";
import { STACKS, type StackDefinition, PACKAGE_BUILD_CACHES } from "@repo/core";
import type { BuildConfig } from "../../types";
import { normalizeDockerRootDirectory } from "../docker-paths";

/** Cache-only paths. Installed packages and final binaries stay in image layers.
 * Mounting node_modules, target/, .nuxt, etc. would hide required build outputs.
 * Yarn is omitted: Classic and modern PnP loaders can reference global package
 * archives at runtime, so those dependencies must stay in image layers. */
const NODE_MANAGERS = new Set(["npm", "bun", "pnpm", "yarn"]);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Session-named generated Dockerfiles otherwise invalidate COPY on every
 * monorepo deployment, even when application sources have not changed. */
export function generatedBuildIgnore(contents: string): string {
  if (contents.split(/\r?\n/).includes("Dockerfile.openship*")) return contents;
  return `${contents}${contents.endsWith("\n") || !contents ? "" : "\n"}# OpenShip generated build files\nDockerfile.openship*\n`;
}

export function cachedRunPrefix(
  config: BuildConfig,
  packageManager = config.packageManager,
): string {
  if (!config.buildCache || !config.projectId) return "RUN ";
  // These paths describe stock root-user images. A custom image may seed an
  // offline cache or use another HOME/UID; preserve its existing RUN semantics.
  if (
    !/^(?:(?:docker\.io\/)?(?:library\/)?)?(?:node|oven\/bun|python|php|ruby|golang|rust|maven|elixir)(?::|@|$)/.test(
      config.buildImage,
    ) &&
    !/^mcr\.microsoft\.com\/dotnet\/sdk(?::|@|$)/.test(config.buildImage)
  )
    return "RUN ";
  const root = normalizeDockerRootDirectory(config.rootDirectory, config.localPath);
  const source = root ? `/workspace/${root}` : "/workspace";
  const stack = (STACKS as Record<string, StackDefinition>)[config.stack];
  const packagePaths = [...(PACKAGE_BUILD_CACHES[packageManager] ?? [])];
  const outputPaths = [...(stack?.buildCacheDirs ?? [])].map((path) => `${source}/${path}`);
  if (NODE_MANAGERS.has(packageManager)) {
    outputPaths.push("/workspace/.turbo/cache", `${source}/.turbo/cache`);
  }
  const scope = [
    "v1",
    config.projectId,
    config.repoUrl,
    config.branch,
    root,
    config.buildImage,
    config.runtimeVersion,
    packageManager,
  ];
  // Compilation may depend on build environment or commands. Hash values;
  // neither secrets nor user strings appear in mount IDs or cleanup metadata.
  const buildInputs = [
    config.stack,
    config.installCommand,
    config.workspacePrepareCommand,
    config.buildCommand,
    Object.entries(config.envVars ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  ];
  const output = config.outputDirectory?.replace(/^\.\//, "").replace(/\/+$/, "");
  const mounts = [...new Set([...packagePaths, ...outputPaths])]
    .filter((path) => {
      if (!/^\/[A-Za-z0-9._/-]+$/.test(path)) return false;
      const out = output ? `${source}/${output}` : source;
      return !(out === path || out.startsWith(`${path}/`));
    })
    .map((path) => {
      const id = digest([scope, path, packagePaths.includes(path) ? "packages" : buildInputs]);
      // Exclusive writers also work for tools whose cache format is not concurrent.
      return `--mount=type=cache,id=openship-${id}-\${TARGETPLATFORM},target=${path},sharing=locked`;
    });
  return mounts.length ? `RUN ${mounts.join(" ")} ` : "RUN ";
}
