/**
 * A repository Compose file was read successfully enough to determine that its
 * requested deployment cannot be represented safely.
 *
 * Callers may retry ordinary source/network failures with the last imported
 * service shape, but must never do that for this error: deploying stale Compose
 * configuration after the file changed is less safe than refusing the deploy.
 */
import { AppError } from "@repo/core";

export class ComposeConfigurationError extends AppError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 400, "COMPOSE_CONFIGURATION_INVALID");
    if (options?.cause !== undefined) this.cause = options.cause;
    this.name = "ComposeConfigurationError";
  }
}
