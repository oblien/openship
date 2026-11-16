import { DeployError, registryForImage, safeErrorMessage } from "@repo/core";

function isRegistryAccessDenied(error: unknown): boolean {
  const failure = error as { statusCode?: number; message?: string } | null;
  return failure?.statusCode === 401 || failure?.statusCode === 403 ||
    /\b(?:unauthorized|authentication required|incorrect username or password|pull access denied|requested access to the resource is denied|insufficient_scope)\b|(?:^|:\s*)denied\b/i.test(failure?.message ?? "");
}

/** Diagnose the final pull failure, after the public-image fallback. Only image
 * identity belongs in recovery metadata; never include credentials or raw errors. */
export function registryAccessError(ref: string, error: unknown): DeployError | undefined {
  if (!isRegistryAccessDenied(error)) return undefined;
  const registry = registryForImage(ref);
  return new DeployError(
    `Cannot pull ${ref}: ${registry} denied access. Check that the image exists, then add or update ` +
    `its credential in Settings → Connections → Container registry with permission to pull this image. ` +
    (registry === "ghcr.io" ? "GitHub clone credentials are separate from container registry credentials. " : "") +
    `Refresh images and redeploy after updating access. Registry response: ${safeErrorMessage(error)}`,
    "REGISTRY_ACCESS_DENIED",
    { registry, imageRef: ref },
  );
}

/** A rejected registry login must not make a public image unavailable.
 * Retry anonymously once; a private image still needs registry authorization.
 * Preserve the original diagnostic if anonymous access is also rejected. */
export async function pullWithAnonymousFallback<T>(
  pull: (anonymous: boolean) => Promise<T>,
  onRetry: () => void,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await pull(false);
  } catch (error) {
    if (signal?.aborted || !isRegistryAccessDenied(error)) throw error;
    onRetry();
    try {
      return await pull(true);
    } catch (anonymousError) {
      if (signal?.aborted) throw anonymousError;
      throw error;
    }
  }
}
