function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on", "debug"].includes(value.toLowerCase());
}

export function isSystemDebugEnabled(): boolean {
  return isTruthy(process.env.SYSTEM_DEBUG_LOGS);
}

export function systemDebug(scope: string, message: string): void {
  if (!isSystemDebugEnabled()) return;
  const timestamp = new Date().toISOString();
  console.log(`[system-debug] ${timestamp} [${scope}] ${message}`);
}

export function formatDuration(startMs: number): string {
  return `${Date.now() - startMs}ms`;
}