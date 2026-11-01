import { STACKS, type StackDefinition } from "./stacks";
import { normalizeAppVolume } from "./volumes";
import { parseVolumeMount } from "./volume-spec";

export const PACKAGE_BUILD_CACHES: Readonly<Record<string, readonly string[]>> = {
  npm: ["/root/.npm"],
  bun: ["/root/.bun/install/cache"],
  pnpm: ["/root/.local/share/pnpm/store"],
  pip: ["/root/.cache/pip"],
  pipenv: ["/root/.cache/pip"],
  poetry: ["/root/.cache/pypoetry/cache", "/root/.cache/pypoetry/artifacts"],
  uv: ["/root/.cache/uv"],
  composer: ["/root/.cache/composer"],
  bundler: ["/usr/local/bundle/cache"],
  cargo: ["/usr/local/cargo/registry", "/usr/local/cargo/git"],
  go: ["/go/pkg/mod", "/root/.cache/go-build"],
  maven: ["/root/.m2/repository"],
  gradle: ["/root/.gradle/caches", "/root/.gradle/wrapper"],
  dotnet: ["/root/.nuget/packages"],
  mix: ["/root/.hex/packages"],
};

export function managedCacheTargets(
  stack: string,
  packageManager: string,
  rootDirectory = "",
): string[] {
  const root = rootDirectory.replace(/^\/+|\/+$/g, "");
  const source = root ? `/workspace/${root}` : "/workspace";
  const definition = (STACKS as Record<string, StackDefinition>)[stack];
  return [
    ...new Set([
      ...(PACKAGE_BUILD_CACHES[packageManager] ?? []),
      ...(definition?.buildCacheDirs ?? []).map((path) => `${source}/${path}`),
      ...(["npm", "bun", "pnpm", "yarn"].includes(packageManager)
        ? ["/workspace/.turbo/cache", `${source}/.turbo/cache`]
        : []),
    ]),
  ];
}

export function manualBuildCaches(input: {
  framework?: string | null;
  packageManager?: string | null;
  rootDirectory?: string | null;
  volumes?: readonly string[] | null;
}) {
  const root = input.rootDirectory?.replace(/^\/+|\/+$/g, "") ?? "";
  const source = root ? `/workspace/${root}` : "/workspace";
  const targets = managedCacheTargets(input.framework ?? "", input.packageManager ?? "", root);
  return (input.volumes ?? []).flatMap((spec) => {
    const normalized = normalizeAppVolume(spec);
    if (!normalized) return [];
    const target = parseVolumeMount(normalized).target.replace(/\/+$/, "");
    const canonical = target?.startsWith("/app/") ? source + target.slice(4) : target;
    return canonical && targets.includes(canonical) ? [{ spec, target: canonical }] : [];
  });
}
