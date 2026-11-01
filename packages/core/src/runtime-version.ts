import { validateImageReference } from "./project-source";
import { ValidationError } from "./errors";
import { LANGUAGES, STACKS, normalizeFramework, type StackId, type Language } from "./stacks";
import {
  DEFAULT_PHP_VERSION,
  PHP_VERSIONS,
  phpNeedsInstall,
  resolvePhpImages,
} from "./php-version";

/** Public syntax is independent of the runtime's supported version catalog. */
export const RUNTIME_VERSION_PATTERN = "^[0-9]+(?:\\.[0-9]+){0,2}(?![\\s\\S])";
export const RUNTIME_VERSION_MAX_LENGTH = 32;
const versionPattern = new RegExp(RUNTIME_VERSION_PATTERN);

export function isRuntimeVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= RUNTIME_VERSION_MAX_LENGTH &&
    versionPattern.test(value)
  );
}

interface RuntimeImages {
  runtimeVersion: string;
  buildImage: string;
  runtimeImage: string;
}

interface RuntimeVersionPolicy {
  label: string;
  defaultVersion: string;
  versions: readonly string[];
  legacyBuildImage: string;
  images(version: string): { buildImage: string; runtimeImage: string };
  resolve(
    version: unknown,
    buildImage?: string | null,
    runtimeImage?: string | null,
  ): RuntimeImages;
  needsInstall(version: unknown, installCommand?: string | null): boolean;
}

/** Add explicit-version support by supplying an actual build/runtime policy,
 * rather than adding language-specific project columns or API fields. */
const policies: Partial<Record<Language, RuntimeVersionPolicy>> = {
  php: {
    label: "PHP",
    defaultVersion: DEFAULT_PHP_VERSION,
    versions: PHP_VERSIONS,
    legacyBuildImage: LANGUAGES.php.buildImage,
    images: (version) => resolvePhpImages(version),
    resolve: resolvePhpImages,
    needsInstall: phpNeedsInstall,
  },
};

export function getRuntimeVersionPolicy(
  framework?: string | null,
): RuntimeVersionPolicy | undefined {
  const language = STACKS[normalizeFramework(framework) as StackId]?.language;
  return language ? policies[language] : undefined;
}

function requirePolicy(framework?: string | null): RuntimeVersionPolicy {
  const policy = getRuntimeVersionPolicy(framework);
  if (!policy) {
    throw new ValidationError(
      `runtimeVersion is not supported for ${framework || "an undetected runtime"}. Remove runtimeVersion or choose a stack with explicit runtime-version support.`,
    );
  }
  return policy;
}

export function resolveRuntimeImages(
  framework: string | null | undefined,
  version: unknown,
  buildImage?: string | null,
  runtimeImage?: string | null,
): RuntimeImages {
  if (!isRuntimeVersion(version)) {
    throw new ValidationError("runtimeVersion must be a numeric version such as 8.3 or 8.3.1");
  }
  return requirePolicy(framework).resolve(version, buildImage, runtimeImage);
}

/** Config files can validate a declared stack immediately; scans validate after
 * detection when the stack is omitted. Returns a field error without throwing. */
export function runtimeVersionError(
  framework: string | null | undefined,
  version: unknown,
): string | undefined {
  if (!isRuntimeVersion(version)) return "must be a numeric version such as 8.3 or 8.3.1";
  const policy = getRuntimeVersionPolicy(framework);
  if (!policy) return `is not supported for ${framework || "an undetected runtime"}`;
  if (!policy.versions.includes(version))
    return `Unsupported runtimeVersion ${JSON.stringify(version)}. For ${policy.label}, choose ${policy.versions.join(" or ")}.`;
  return undefined;
}

export function runtimeNeedsInstall(
  framework: string | null | undefined,
  version: unknown,
  installCommand?: string | null,
): boolean {
  return getRuntimeVersionPolicy(framework)?.needsInstall(version, installCommand) ?? false;
}

interface RuntimeImageTarget {
  runtimeMode?: string | null;
  projectType?: string | null;
  composePath?: string | null;
  buildKind?: string | null;
  sourceKind?: string | null;
  workloadType?: string | null;
}

/** Image overrides belong to generated Docker recipes, including static builds. */
export function supportsBuildImageOverride(config: RuntimeImageTarget): boolean {
  return !(
    config.runtimeMode === "bare" ||
    ["monorepo", "compose", "services", "docker"].includes(config.projectType ?? "") ||
    config.composePath ||
    (config.buildKind && !["buildpack", "static"].includes(config.buildKind)) ||
    config.sourceKind === "image"
  );
}

/** The wizard and server use the same ownership rules for generated runtime images. */
export function supportsRuntimeImageOverride(config: RuntimeImageTarget): boolean {
  return supportsBuildImageOverride(config) &&
    config.buildKind !== "static" && config.workloadType !== "static";
}

/** No explicit selection is silently ignored on an unsupported execution path. */
export function assertRuntimeVersionTarget(config: RuntimeImageTarget & {
  runtimeVersion?: unknown;
  runtimeImage?: unknown;
  framework?: string | null;
}) {
  if (config.runtimeVersion == null && config.runtimeImage == null) return;
  normalizeRuntimeImageOverride(config.runtimeImage);
  if (config.runtimeVersion != null)
    resolveRuntimeImages(
      config.framework,
      config.runtimeVersion,
      undefined,
      typeof config.runtimeImage === "string" ? config.runtimeImage : undefined,
    );
  const policy = getRuntimeVersionPolicy(config.framework);
  if (!supportsRuntimeImageOverride(config)) {
    throw new ValidationError(
      `${config.runtimeVersion != null ? "runtimeVersion" : "runtimeImage"} requires an Openship-generated ${policy?.label ? `${policy.label} ` : ""}Docker build. Remove runtimeVersion and runtimeImage for bare runtimes, static sites, Compose/monorepo services, prebuilt images or your own Dockerfile.`,
    );
  }
}

/** Omission preserves the selection; null clears it. Only managed image
 * defaults follow a version change, while custom overrides stay explicit. */
export function normalizeRuntimeImageOverride(value: unknown): string | null | undefined {
  if (value == null) return value;
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 200 ||
    validateImageReference(value.trim())
  )
    throw new ValidationError(
      "runtimeImage must be a valid Docker image reference, or null to restore the default",
    );
  return value.trim();
}

export function runtimeProjectUpdate(
  previous: {
    framework?: string | null;
    runtimeVersion?: string | null;
    buildImage?: string | null;
    runtimeImage?: string | null;
  } | null,
  changes: {
    framework?: string | null;
    runtimeVersion?: unknown;
    buildImage?: unknown;
    runtimeImage?: unknown;
  },
): { runtimeVersion?: string | null; buildImage?: string; runtimeImage?: string | null } {
  const version =
    changes.runtimeVersion === undefined ? previous?.runtimeVersion : changes.runtimeVersion;
  const framework = changes.framework === undefined ? previous?.framework : changes.framework;
  const policy = getRuntimeVersionPolicy(framework);
  const previousPolicy = getRuntimeVersionPolicy(previous?.framework ?? framework);
  const previousDefault = previousPolicy
    ? previous?.runtimeVersion && previousPolicy.versions.includes(previous.runtimeVersion)
      ? previousPolicy.images(previous.runtimeVersion).buildImage
      : previousPolicy.legacyBuildImage
    : undefined;
  const runtimeImage = normalizeRuntimeImageOverride(
    changes.runtimeImage === undefined ? previous?.runtimeImage : changes.runtimeImage,
  );
  const overrideUpdate =
    changes.runtimeImage === undefined ? {} : { runtimeImage: runtimeImage ?? null };
  let image = typeof changes.buildImage === "string" ? changes.buildImage : previous?.buildImage;
  if (version == null) {
    const reset: { runtimeVersion?: null; buildImage?: string } =
      changes.runtimeVersion === null
        ? {
            runtimeVersion: null,
            ...(previousPolicy && {
              buildImage:
                !image || image === previousDefault ? previousPolicy.legacyBuildImage : image,
            }),
          }
        : {};
    if (runtimeImage && policy)
      policy.resolve(policy.defaultVersion, reset.buildImage ?? image, runtimeImage);
    return { ...reset, ...overrideUpdate };
  }
  if (
    changes.runtimeVersion !== undefined &&
    previous &&
    image === previousDefault &&
    (changes.buildImage === undefined || changes.buildImage === previous.buildImage)
  )
    image = undefined;
  const resolved = resolveRuntimeImages(framework, version, image, runtimeImage);
  return {
    runtimeVersion: resolved.runtimeVersion,
    buildImage: resolved.buildImage,
    ...overrideUpdate,
  };
}
