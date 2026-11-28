export const CLOUD_PROJECT_ACTIVITY_SCOPE_PREFIX = "project:";
export const CLOUD_SERVICE_TERMINAL_SCOPE_PREFIX = "service-terminal:";

export function cloudServiceTerminalId(scope: string): string | undefined {
  if (scope.startsWith(CLOUD_SERVICE_TERMINAL_SCOPE_PREFIX))
    return scope.slice(CLOUD_SERVICE_TERMINAL_SCOPE_PREFIX.length) || undefined;
}

export function isCloudTerminalActivity(scope: string): boolean {
  return scope === "terminal" || cloudServiceTerminalId(scope) !== undefined;
}
