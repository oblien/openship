import type {
  ActionArchitecture,
  ActionCapabilities,
  ActionContainerPlatform,
  ActionJobSpec,
  ActionRunnerConfig,
} from "./actions";

export const ACTION_CONTAINER_PLATFORMS: Record<ActionArchitecture, ActionContainerPlatform> = {
  x64: "linux/amd64",
  arm64: "linux/arm64",
};

export function actionDockerPlatforms(capabilities: ActionCapabilities): ActionContainerPlatform[] {
  if (!capabilities.docker) return [];
  return [
    ...new Set([
      ACTION_CONTAINER_PLATFORMS[capabilities.dockerArchitecture ?? capabilities.architecture],
      ...(capabilities.dockerPlatforms ?? []),
    ]),
  ];
}

export function actionRunnerArchitectures(
  capabilities: ActionCapabilities,
  config: Pick<ActionRunnerConfig, "mode">,
): ActionArchitecture[] {
  return config.mode === "native"
    ? [capabilities.architecture]
    : actionDockerPlatforms(capabilities).map((platform) =>
        platform === "linux/arm64" ? "arm64" : "x64",
      );
}

/** The job selects one architecture using standard runs-on labels. */
export function actionContainerPlatform(
  capabilities: ActionCapabilities,
  config: Pick<ActionRunnerConfig, "mode">,
  job: Pick<ActionJobSpec, "labels">,
): ActionContainerPlatform | undefined {
  if (config.mode === "native") return undefined;
  const architectures = job.labels
    .map((label) => label.toLowerCase())
    .filter((label): label is ActionArchitecture => label === "x64" || label === "arm64");
  return ACTION_CONTAINER_PLATFORMS[
    architectures[0] ?? capabilities.dockerArchitecture ?? capabilities.architecture
  ];
}

export function incompatibleActionLabels(
  capabilities: ActionCapabilities,
  config: ActionRunnerConfig,
): string[] {
  const os = config.mode === "container" ? "linux" : capabilities.os;
  const architectures = actionRunnerArchitectures(capabilities, config);
  return config.labels
    .map((label) => label.toLowerCase())
    .filter(
      (label) =>
        (/^(macos|windows)(-|$)/.test(label) && !label.startsWith(os)) ||
        (label === "linux" && os !== "linux") ||
        (/^ubuntu(-|$)/.test(label) && os !== "linux") ||
        ((label === "arm64" || label === "x64") && !architectures.includes(label)),
    );
}

export function actionRunnerLabels(
  capabilities: ActionCapabilities,
  config: ActionRunnerConfig,
): string[] {
  const os = config.mode === "container" ? "linux" : capabilities.os;
  const labels = new Set([
    "self-hosted",
    "openship",
    os,
    ...actionRunnerArchitectures(capabilities, config),
    ...config.labels.map((l) => l.toLowerCase()),
  ]);
  if (os === "macos") labels.add("macos-latest");
  return [...labels];
}

/** A label is a routing hint, never proof that a host can execute a job. */
export function actionRunnerMismatch(
  capabilities: ActionCapabilities | null,
  config: ActionRunnerConfig,
  job: Pick<ActionJobSpec, "labels" | "requiresDocker">,
): string | null {
  if (!capabilities) return "Check this server's capabilities before running workflows.";
  const invalid = incompatibleActionLabels(capabilities, config);
  if (invalid.length)
    return `Runner labels no longer match this server's capabilities: ${invalid.join(", ")}.`;
  if (config.mode === "container" && (!capabilities.docker || !config.image?.trim()))
    return "A working Docker engine and a runner image are required.";
  if (config.mode === "native" && !capabilities.git)
    return "Install Git on this server to run native jobs.";
  if (config.mode === "native" && !capabilities.node)
    return "Install Node.js on this server to run JavaScript actions.";
  if (job.requiresDocker && (config.mode !== "container" || !capabilities.docker))
    return "This job uses containers or services. Choose a Docker runner.";
  const requestedArchitectures = new Set(
    job.labels
      .map((label) => label.toLowerCase())
      .filter((label) => label === "x64" || label === "arm64"),
  );
  if (requestedArchitectures.size > 1)
    return "A job can select one CPU architecture. Use a matrix to run on both x64 and ARM64.";
  const labels = new Set(actionRunnerLabels(capabilities, config));
  const missing = job.labels.filter((label) => !labels.has(label.toLowerCase()));
  if (missing.length) return `This runner does not provide: ${missing.join(", ")}.`;
  return null;
}
