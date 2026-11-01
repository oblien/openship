import { AppError, isMutableImageRef, normalizeRegistryHost, registryForImage } from "@repo/core";
import type { BuildLogger } from "./build-pipeline";

export interface PreparedDockerImage {
  imageId: string;
  deploymentRef: string;
  registryDigest?: string;
}

export interface DockerImagePreparationOptions {
  force?: boolean;
  /** Refresh only a cached image with a digest for this exact repository. */
  refreshMutableTag?: boolean;
  /** Built, pinned and refresh artifacts must already exist; never pull substitutes. */
  requirePresent?: boolean;
  signal?: AbortSignal;
  logger?: BuildLogger;
}

interface ImageInspection {
  Id: string;
  RepoDigests?: string[];
}

function repository(ref: string): string {
  const withoutDigest = ref.trim().split("@")[0]!;
  const colon = withoutDigest.lastIndexOf(":");
  const slash = withoutDigest.lastIndexOf("/");
  const name = colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
  const registry = normalizeRegistryHost(registryForImage(name));
  const first = name.split("/")[0]!;
  const qualified =
    name.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost");
  let path = qualified ? name.slice(name.indexOf("/") + 1) : name;
  if (registry === "docker.io" && !path.includes("/")) path = `library/${path}`;
  return `${registry}/${path}`;
}

export function matchingRegistryDigest(
  ref: string,
  digests: readonly string[] = [],
): string | undefined {
  if (/^sha256:[a-f0-9]{64}$/.test(ref)) return undefined;
  const expected = repository(ref);
  return digests.find(
    (digest) => /@sha256:[a-f0-9]{64}$/.test(digest) && repository(digest) === expected,
  );
}

/** Acquire and freeze an image before activation. Unknown daemon state fails closed. */
export async function prepareDockerImage(
  ref: string,
  options: DockerImagePreparationOptions,
  io: {
    inspect(ref: string): Promise<ImageInspection>;
    pull(ref: string, options: { force: boolean }): Promise<void>;
  },
): Promise<PreparedDockerImage> {
  const checkCancellation = () => {
    if (options.signal?.aborted) throw new Error("Image preparation cancelled");
  };
  checkCancellation();
  let image: ImageInspection | undefined;
  try {
    image = await io.inspect(ref);
  } catch (error) {
    // An ownership denial can also be a 404; it is never permission to pull.
    if (error instanceof AppError || (error as { statusCode?: number })?.statusCode !== 404)
      throw error;
  }
  checkCancellation();
  if (!image && (options.requirePresent || /^sha256:[a-f0-9]{64}$/.test(ref))) {
    throw new Error(`Retained image ${ref} is unavailable. Redeploy to rebuild it.`);
  }
  const refresh =
    options.refreshMutableTag &&
    isMutableImageRef(ref) &&
    !!matchingRegistryDigest(ref, image?.RepoDigests);
  const force = options.force === true && isMutableImageRef(ref);
  if (!image || (!options.requirePresent && (force || refresh))) {
    await io.pull(ref, { force: force || !!image });
    checkCancellation();
    image = await io.inspect(ref);
  }
  checkCancellation();
  if (!/^sha256:[a-f0-9]{64}$/.test(image!.Id)) {
    throw new Error(
      `Cannot resolve an immutable Docker image ID for ${ref}; no service was activated.`,
    );
  }
  const registryDigest = matchingRegistryDigest(ref, image!.RepoDigests);
  return {
    imageId: image!.Id,
    deploymentRef: registryDigest ?? image!.Id,
    ...(registryDigest ? { registryDigest } : {}),
  };
}
