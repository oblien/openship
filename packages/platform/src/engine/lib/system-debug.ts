import { env } from "../config/env";

export function systemDebug(scope: string, message: string): void {
  if (!env.SYSTEM_DEBUG_LOGS) return;
  console.log(`[system-debug][${scope}] ${new Date().toISOString()} ${message}`);
}

export function formatDuration(startMs: number): string {
  return `${Date.now() - startMs}ms`;
}