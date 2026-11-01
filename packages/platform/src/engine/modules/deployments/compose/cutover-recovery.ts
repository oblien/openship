/** Internal signal: routing may reference either container, so cleanup must wait. */
export class ServiceCutoverRecoveryError extends Error {
  constructor(
    readonly containerId: string,
    cause?: unknown,
  ) {
    super(
      "Service routing could not be restored completely. Both containers were preserved for recovery.",
      { cause },
    );
    this.name = "ServiceCutoverRecoveryError";
  }
}
