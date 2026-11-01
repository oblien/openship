import { buildEnvironmentPreflight } from "./build-env-preflight";
import type { BuildConfig } from "../types";
import { getDockerBuildRecipe, resolveRuntimeImages, assertRuntimeVersionTarget } from "@repo/core";
import { generatePhpDockerfile } from "./docker-recipes/php";
import { generateRubyDockerfile } from "./docker-recipes/ruby";
import { generateStaticDockerfile } from "./docker-recipes/static";
import { generateGenericDockerfile } from "./docker-recipes/generic";
import { normalizeDockerRootDirectory } from "./docker-paths";
import { shellQuote } from "@repo/core";

export {
  builderContextRoot,
  isExcludedDocRootEntry,
  staticBuilderOutputPath,
} from "./docker-recipes/static";

const recipes = {
  php: generatePhpDockerfile,
  ruby: generateRubyDockerfile,
  static: generateStaticDockerfile,
  generic: generateGenericDockerfile,
};

export function generateDockerfile(config: BuildConfig): string {
  assertRuntimeVersionTarget({
    runtimeVersion: config.runtimeVersion,
    runtimeImage: config.runtimeImageOverride ? config.runtimeImage : undefined,
    framework: config.stack,
    workloadType: config.isStatic ? "static" : "web",
    buildKind: config.dockerfilePath || config.dockerfileContent ? "dockerfile" : undefined,
  });
  if (config.runtimeVersion != null) {
    resolveRuntimeImages(
      config.stack,
      config.runtimeVersion,
      config.buildImage,
      config.runtimeImage,
    );
  }
  const root = normalizeDockerRootDirectory(config.rootDirectory, config.localPath);
  const workdir = root ? `/workspace/${root}` : "/workspace";
  const preflight = `test -d ${shellQuote(workdir)} || { echo 'Configured root directory does not exist in this revision.' >&2; exit 1; }; cd ${shellQuote(workdir)} && ${buildEnvironmentPreflight(config.envVars)}`;
  const recipe = recipes[getDockerBuildRecipe(config.stack, config.isStatic)](config)
    .replace("COPY . /workspace", `COPY . /workspace\nRUN ${preflight}`);
  if (!config.buildCache) return recipe;
  const cacheTargets = [...new Set([...recipe.matchAll(/--mount=type=cache,[^\s]*target=([^,\s]+)/g)].map(match => match[1]))];
  // Automatic platform args need declaring in each stage for mount ID expansion.
  return recipe.replace(/^(FROM .+)$/gm, "$1\nARG TARGETPLATFORM") + (cacheTargets.length ? `\nLABEL io.openship.build-cache-targets=${JSON.stringify(JSON.stringify(cacheTargets))}` : "");
}
