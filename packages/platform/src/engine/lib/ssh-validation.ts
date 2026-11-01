import { assertSshSettings, safeErrorMessage } from "@repo/core";
import { OperationError } from "@repo/contracts";
import { reportCaughtError } from "@repo/core/diagnostics";

/** Convert shared SSH validation failures into a client error at request boundaries. */
export function validateSshConnectionOptions(
  settings: Parameters<typeof assertSshSettings>[0],
): void {
  try {
    assertSshSettings(settings);
  } catch (error) {
    reportCaughtError(error, "platform/engine/lib/ssh-validation");
    const message = safeErrorMessage(error);
    throw new OperationError(message, 400, "SERVER_OPERATION_FAILED", { error: message });
  }
}
