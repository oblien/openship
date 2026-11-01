import { validateImageReference } from "./project-source";
import { ValidationError } from "./errors";

/** Versions verified with the generated Composer + FrankenPHP recipe. */
export const PHP_VERSIONS = ["8.3", "8.4"] as const;
export type PhpVersion = (typeof PHP_VERSIONS)[number];
export const DEFAULT_PHP_VERSION: PhpVersion = "8.4";

export function isPhpVersion(value: unknown): value is PhpVersion {
  return PHP_VERSIONS.some((version) => version === value);
}

/** A selected PHP source still needs Composer when it has no JS asset build. */
export function phpNeedsInstall(version: unknown, installCommand?: string | null): boolean {
  return isPhpVersion(version) && !!installCommand?.trim();
}

export function phpImagePair(version: PhpVersion) {
  return {
    buildImage: `php:${version}-cli-bookworm`,
    runtimeImage: `dunglas/frankenphp:1-php${version}-bookworm`,
  };
}

/** A custom builder is preserved, and its actual PHP binary is checked in the
 * recipe. Known incompatible official PHP tags are rejected before a build. */
export function resolvePhpImages(
  version: unknown,
  buildImage?: string | null,
  runtimeImage?: string | null,
) {
  if (!isPhpVersion(version)) {
    throw new ValidationError(
      `Unsupported runtimeVersion ${JSON.stringify(version)}. For PHP, choose ${PHP_VERSIONS.join(" or ")}.`,
    );
  }
  const pair = phpImagePair(version);
  const override = buildImage?.trim();
  if (override && validateImageReference(override))
    throw new ValidationError("buildImage must be a valid Docker image reference");
  const runtimeOverride = runtimeImage?.trim();
  if (runtimeOverride && validateImageReference(runtimeOverride))
    throw new ValidationError("runtimeImage must be a valid Docker image reference");
  if (
    runtimeOverride &&
    /^(?:(?:docker\.io\/)?library\/)?(?:php|node|ruby|nginx)(?::|@|$)/.test(runtimeOverride)
  ) {
    throw new ValidationError(
      "runtimeImage must provide FrankenPHP for the generated PHP recipe. Use a compatible custom image or your own Dockerfile.",
    );
  }
  const declaredRuntimeVersion =
    /^(?:docker\.io\/)?dunglas\/frankenphp:[^@]*-php(\d+\.\d+)(?:\.|-|@|$)/.exec(
      runtimeOverride ?? "",
    )?.[1];
  if (declaredRuntimeVersion && declaredRuntimeVersion !== version)
    throw new ValidationError(
      `runtimeImage ${runtimeOverride} uses PHP ${declaredRuntimeVersion}, but runtimeVersion is ${version}.`,
    );
  if (!override)
    return {
      runtimeVersion: version,
      ...pair,
      ...(runtimeOverride && { runtimeImage: runtimeOverride }),
    };
  const declaredVersion = /^(?:(?:docker\.io\/)?library\/)?php:(\d+\.\d+)(?:\.|-|@|$)/.exec(
    override,
  )?.[1];
  if (declaredVersion && declaredVersion !== version) {
    throw new ValidationError(
      `buildImage ${override} uses PHP ${declaredVersion}, but runtimeVersion is ${version}. Use ${pair.buildImage} or a compatible custom builder.`,
    );
  }
  return {
    runtimeVersion: version,
    ...pair,
    buildImage: override,
    ...(runtimeOverride && { runtimeImage: runtimeOverride }),
  };
}
