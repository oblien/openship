import { AppError, isProtectedBuildKitConfig, buildImageRef } from "@repo/core";
import type { CommandExecutor, LogCallback } from "../types";
import { sq } from "./build-pipeline";

let pinnedImage: string | (() => string) | undefined;
let deliver:
  | ((executor: CommandExecutor, image: string, onLog: LogCallback) => Promise<unknown>)
  | undefined;

/** API boot supplies its version and optional trusted from-source delivery.
 * This configuration never comes from a project's image or request payload. */
export function setDefaultBuildKitImage(
  image: string | (() => string),
  delivery?: (executor: CommandExecutor, image: string, onLog: LogCallback) => Promise<unknown>,
): void {
  pinnedImage = image;
  deliver = delivery;
}

export function resolveBuildKitImage(): string {
  return buildImageRef(
    { injectedDefault: typeof pinnedImage === "function" ? pinnedImage() : pinnedImage },
    {
      name: "openship-buildkit",
      imageOverride: process.env.OPENSHIP_BUILDKIT_IMAGE,
      tagOverride: process.env.OPENSHIP_BUILDKIT_TAG,
    },
  );
}

function unavailable(cause: unknown): AppError {
  return Object.assign(
    new AppError(
      "Remote build protection is unavailable. Use rootful Linux Docker with Buildx and the Openship BuildKit image matching this release. No repository build commands were run.",
      503,
      "BUILD_METADATA_PROTECTION_UNAVAILABLE",
    ),
    { cause },
  );
}

/** Refuse an unsupported daemon BEFORE pulling/building a worker or running
 * repository commands. Docker Desktop controlling a Linux server is unchanged. */
export async function requireProtectedBuildHost(executor: CommandExecutor): Promise<void> {
  try {
    const info = JSON.parse(await executor.exec("docker info --format '{{json .}}'")) as {
      OSType?: unknown;
      SecurityOptions?: unknown;
    };
    if (
      info.OSType !== "linux" ||
      !Array.isArray(info.SecurityOptions) ||
      info.SecurityOptions.some((option) => typeof option !== "string" || /rootless/i.test(option))
    )
      throw new Error("Remote build protection requires a rootful Linux Docker daemon.");
  } catch (cause) {
    throw unavailable(cause);
  }
}

/** Dev delivery uses the existing managed-image pipeline. Production uses a
 * published, version-pinned artifact; missing artifacts fail instead of falling
 * back to unguarded moby/buildkit or the daemon's native builder. */
export async function prepareProtectedBuildKitImage(
  executor: CommandExecutor,
  acquire: (image: string) => Promise<unknown>,
  onLog: LogCallback,
): Promise<string> {
  const image = resolveBuildKitImage();
  try {
    if (deliver) await deliver(executor, image, onLog);
    await acquire(image);
    const configs = JSON.parse(await executor.exec(`docker image inspect ${sq(image)}`)) as Array<{
      Config?: { Labels?: Record<string, string>; Entrypoint?: string[] };
    }>;
    const config = configs.length === 1 ? configs[0]?.Config : undefined;
    if (!isProtectedBuildKitConfig(config))
      throw new Error("The selected worker image does not contain the required metadata guard.");
    return image;
  } catch (cause) {
    throw unavailable(cause);
  }
}

/** Keep the worker outside the Docker host's network namespace. Its guarded
 * entrypoint runs on every bootstrap/restart before the daemon serves builds. */
export const PROTECTED_BUILDKIT_DRIVER_OPTIONS = ["network=bridge", "restart-policy=no"] as const;
