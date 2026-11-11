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
    const failure = error as { statusCode?: number; message?: string } | null;
    if (signal?.aborted || !(
      failure?.statusCode === 401 || failure?.statusCode === 403 ||
      /\b(?:unauthorized|authentication required|incorrect username or password|pull access denied|requested access to the resource is denied)\b|(?:^|:\s*)denied\b/i.test(failure?.message ?? "")
    )) throw error;
    onRetry();
    try {
      return await pull(true);
    } catch (anonymousError) {
      if (signal?.aborted) throw anonymousError;
      throw error;
    }
  }
}
