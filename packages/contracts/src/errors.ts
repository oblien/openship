import { AppError } from "@repo/core";

/** Application failure with explicitly public, serializable recovery details. */
export class OperationError extends AppError {
  constructor(
    message: string,
    statusCode: number,
    code?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message, statusCode, code);
    this.name = "OperationError";
  }
}
