/** Bounded logs for containers created and managed by Openship. */
export const DEFAULT_CONTAINER_LOG_CONFIG = {
  Type: "json-file",
  Config: { "max-size": "20m", "max-file": "3" },
} as const;

// These are fixed policy values, not shell input. Always select the driver too:
// Docker's host default may not accept json-file's rotation options.
export const DEFAULT_CONTAINER_LOG_ARGS = [
  `--log-driver ${DEFAULT_CONTAINER_LOG_CONFIG.Type}`,
  ...Object.entries(DEFAULT_CONTAINER_LOG_CONFIG.Config).map(([key, value]) => `--log-opt ${key}=${value}`),
];
