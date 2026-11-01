import { diagnosticProperty, diagnosticStack, redactDiagnosticText } from "./redaction";
import type { DiagnosticError, ErrorCategory, ErrorContext, ErrorSeverity } from "./types";

export function diagnosticError(
  value: unknown,
  depth = 0,
  seen = new Set<unknown>(),
): DiagnosticError {
  if (seen.has(value)) return { name: "Error", message: "[circular cause]" };
  seen.add(value);
  const message = diagnosticProperty(value, "message");
  const name = diagnosticProperty(value, "name");
  const code = diagnosticProperty(value, "code");
  const safeCode =
    typeof code === "string" &&
    /^[\w.-]{1,100}$/.test(code) &&
    redactDiagnosticText(code, 100) === code
      ? code
      : undefined;
  const stack = diagnosticStack(value);
  const result: DiagnosticError = {
    name: typeof name === "string" ? redactDiagnosticText(name, 80) : "Error",
    message: redactDiagnosticText(
      typeof message === "string"
        ? message
        : typeof value === "string"
          ? value
          : value === null
            ? "null rejection"
            : ["number", "boolean", "undefined"].includes(typeof value)
              ? String(value)
              : "Unknown error",
    ),
    ...(safeCode ? { code: safeCode } : {}),
  };
  if (typeof stack === "string") {
    // Do not repeat a raw error message/payload at the head of its stack.
    // Preserve useful call sites even if a database query was redacted above.
    const frames = stack
      .slice(0, 16_384)
      .split("\n")
      .filter((line) => /^\s*(?:at\s|[\w.$<>]*@(?:https?|file):)/.test(line))
      .slice(0, 16);
    if (frames.length) result.stack = redactDiagnosticText(frames.join("\n"), 4096);
  }
  if (depth < 2) {
    const cause = diagnosticProperty(value, "cause");
    if (cause !== undefined) result.cause = diagnosticError(cause, depth + 1, seen);
    const errors = diagnosticProperty(value, "errors");
    if (Array.isArray(errors)) {
      result.errors = [];
      const length = diagnosticProperty(errors, "length");
      for (let index = 0; index < Math.min(typeof length === "number" ? length : 0, 3); index++) {
        result.errors.push(
          diagnosticError(diagnosticProperty(errors, String(index)), depth + 1, seen),
        );
      }
    }
  }
  return result;
}

export function classifyError(
  error: DiagnosticError,
  context: ErrorContext,
): {
  category: ErrorCategory;
  severity: ErrorSeverity;
} {
  const code =
    context.code ??
    error.code ??
    error.cause?.code ??
    error.cause?.cause?.code ??
    error.cause?.errors?.find((item) => item.code)?.code ??
    "";
  const status = context.statusCode;
  let category: ErrorCategory;
  if (error.name === "AbortError" || /^(ABORT_ERR|CANCELLED|DEPLOYMENT_CANCELLED)$/.test(code))
    category = "cancelled";
  else if (status === 401) category = "authentication";
  else if (status === 403) category = "authorization";
  else if (status === 429) category = "rate_limit";
  else if (/CAPACITY|QUOTA|LIMIT_REACHED|INSUFFICIENT_RESOURCES/.test(code)) category = "capacity";
  else if (
    status === 402 ||
    /BILLING|CHECKOUT|PAYMENT|SUBSCRIPTION|PLAN_|CREDITS_EXHAUSTED|INSUFFICIENT_CREDITS/.test(code)
  )
    category = "billing";
  else if (
    /ENOSPC|EDQUOT|DISK_FULL/.test(code) ||
    /\b(?:no space left on device|disk quota exceeded)\b/i.test(error.message)
  )
    category = "storage";
  else if (
    /^(?:22|23|28|40|42|53|57|58)[\dA-Z]{3}$/.test(code) ||
    /SQLITE_|DATABASE_|Drizzle|QueryFailed/.test(code + error.name)
  )
    category = "database";
  else if (
    status === 408 ||
    status === 504 ||
    error.name === "TimeoutError" ||
    /TIMEOUT|TIMEDOUT/.test(code)
  )
    category = "timeout";
  else if (/ECONN|ENET|EHOST|EAI_AGAIN|ENOTFOUND|HOST_UNREACHABLE|NETWORK/.test(code))
    category = "network";
  else if (
    status === 400 ||
    status === 422 ||
    error.name === "ZodError" ||
    /VALIDATION|INVALID_JSON/.test(code)
  )
    category = "validation";
  else if (status === 404) category = "not_found";
  else if (status === 409) category = "conflict";
  else if (status === 502 || status === 503 || /OBLIEN|PROVIDER|UPSTREAM/.test(code))
    category = "dependency";
  else if (context.kind === "deployment") category = "deployment";
  else category = "internal";
  return {
    category: context.category ?? category,
    severity:
      context.severity ??
      (category === "cancelled" ? "info" : status && status < 500 ? "warn" : "error"),
  };
}
