import type { ActionCapabilities, ActionJobSpec, ActionRunnerConfig } from "./actions";

export function incompatibleActionLabels(
  capabilities: ActionCapabilities,
  config: ActionRunnerConfig,
): string[] {
  const os = config.mode === "container" ? "linux" : capabilities.os;
  return config.labels
    .map((label) => label.toLowerCase())
    .filter(
      (label) =>
        (/^(macos|windows)(-|$)/.test(label) && !label.startsWith(os)) ||
        (label === "linux" && os !== "linux") ||
        (/^ubuntu(-|$)/.test(label) && os !== "linux") ||
        (["arm64", "x64"].includes(label) && label !== capabilities.architecture),
    );
}

export function actionRunnerLabels(
  capabilities: ActionCapabilities,
  config: ActionRunnerConfig,
): string[] {
  const os = config.mode === "container" ? "linux" : capabilities.os;
  const labels = new Set([
    "self-hosted",
    os,
    capabilities.architecture,
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
  if (config.mode === "container" && (!capabilities.docker || !config.image))
    return "A working Docker engine and a runner image are required.";
  if (config.mode === "native" && !capabilities.git)
    return "Install Git on this server to run native jobs.";
  if (config.mode === "native" && !capabilities.node)
    return "Install Node.js on this server to run JavaScript actions.";
  if (job.requiresDocker && (config.mode !== "container" || !capabilities.docker))
    return "This job uses containers or services. Choose a Docker runner.";
  const labels = new Set(actionRunnerLabels(capabilities, config));
  const missing = job.labels.filter((label) => !labels.has(label.toLowerCase()));
  if (missing.length) return `This runner does not provide: ${missing.join(", ")}.`;
  return null;
}
