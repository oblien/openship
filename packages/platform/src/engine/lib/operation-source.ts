import { AsyncLocalStorage } from "node:async_hooks";
import type { ExecutionContext } from "@repo/platform";

export const AUDIT_SOURCES = ["dashboard", "mcp", "cli", "api", "webhook", "system"] as const;
export type AuditSource = NonNullable<ExecutionContext["source"]>;

export function isAuditSource(value: unknown): value is AuditSource {
  return typeof value === "string" && (AUDIT_SOURCES as readonly string[]).includes(value);
}

/** Shared shape for persisted client attribution and audit filters. */
export function isAuditClientId(value: unknown): value is string {
  return typeof value === "string" && /^(?:oauth|pat):[A-Za-z0-9_.\-]{1,128}$/.test(value);
}

const ambient = new AsyncLocalStorage<{ value: AuditSource }>();

export function runWithOperationSource<T>(source: AuditSource, fn: () => T): T {
  return ambient.run({ value: source }, fn);
}

export function setOperationSource(source: AuditSource): void {
  const holder = ambient.getStore();
  if (holder) holder.value = source;
}

export function ambientCallSource(): AuditSource | null {
  return ambient.getStore()?.value ?? null;
}
