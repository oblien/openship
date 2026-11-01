/**
 * A repository Compose file was read successfully enough to determine that its
 * requested deployment cannot be represented safely.
 *
 * Callers may retry ordinary source/network failures with the last imported
 * service shape, but must never do that for this error: deploying stale Compose
 * configuration after the file changed is less safe than refusing the deploy.
 */
export class ComposeConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ComposeConfigurationError";
  }
}
