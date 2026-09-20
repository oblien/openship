import { OperationError } from "@repo/contracts";

/** Remote failures share the native error family and retain HTTP diagnostics. */
export class ApiError extends OperationError {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    const details =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : undefined;
    super(message, status, typeof details?.code === "string" ? details.code : undefined, details);
    this.name = "ApiError";
  }
}

export async function responseError(response: Response): Promise<ApiError> {
  const text = await response.text();
  let body: unknown = text || null;
  try {
    body = JSON.parse(text);
  } catch {
    // Reverse proxies may return text/HTML instead of the application's JSON.
  }
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const message =
    typeof record?.error === "string"
      ? record.error
      : typeof record?.message === "string"
        ? record.message
        : "API error: " + response.status;
  return new ApiError(message, response.status, body);
}
