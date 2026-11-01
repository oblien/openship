import { OperationError } from "@repo/contracts";

/** Raise an application failure with only the deliberately public recovery data. */
export function failOperation(details: Record<string, unknown>, statusCode: number): never {
  const message =
    typeof details.error === "string"
      ? details.error
      : typeof details.message === "string"
        ? details.message
        : "Operation failed";
  throw new OperationError(
    message,
    statusCode,
    typeof details.code === "string" ? details.code : "PROJECT_OPERATION_FAILED",
    details,
  );
}
