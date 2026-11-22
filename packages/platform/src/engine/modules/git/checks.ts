import { redactDiagnosticText } from "@repo/core/diagnostics";

/** Bounded summaries only. Do not attach build logs, environments or provider payloads. */
export function checkFailureSummary(message: string, secrets: readonly string[] = []): string {
  return redactDiagnosticText(message, 4000, secrets);
}
