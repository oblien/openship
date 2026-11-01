/** Refuse tenant build commands on the control-plane host. */
export class HostBuildForbiddenError extends Error {
  readonly code = "HOST_BUILD_FORBIDDEN" as const;
  constructor(message: string) {
    super(message);
    this.name = "HostBuildForbiddenError";
  }
}

export function isHostBuildForbiddenError(err: unknown): err is HostBuildForbiddenError {
  return (
    err instanceof HostBuildForbiddenError ||
    (err instanceof Error && err.name === "HostBuildForbiddenError")
  );
}
