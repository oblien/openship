import { builderCompatibilityLines, runtimeCompatibilityLines } from "./compatibility";
import type { BuildConfig } from "../../types";
import { normalizeDockerRootDirectory } from "../docker-paths";
import { managedNodeDockerLines } from "../cloud/node-listener";
import { prepareNodeOutputCommand, AUTOMATIC_START, START_SOURCE_LABEL, START_COMMAND_LABEL, startCommandDigest } from "../node-output";
import {
  builderSourceDir,
  needsMultiStage,
  buildEnvPrefix,
  nodeBinPathEnvLine,
  workspacePrepareRunLine,
  installBuildRunLine,
  runtimeCopyDirectives,
} from "./shared";

export function generateGenericDockerfile(config: BuildConfig): string {
  const sourceDir = builderSourceDir(
    normalizeDockerRootDirectory(config.rootDirectory, config.localPath),
  );
  const multiStage = needsMultiStage(config) || !!config.runtimeImageOverride;
  const envPrefix = buildEnvPrefix(config.envVars);
  const workspacePrepare = config.workspacePrepareCommand?.trim();

  const lines: string[] = [
    multiStage ? `FROM ${config.buildImage} AS builder` : `FROM ${config.runtimeImage}`,
  ];

  // Ahead of COPY so the layer survives every source change. On the single-stage
  // path this is also the runtime stage — WORKDIR is left at `sourceDir` and
  // node_modules is right there — so one line covers build AND start.
  const buildBinPath = nodeBinPathEnvLine(config.packageManager, [sourceDir, "/workspace"]);
  if (buildBinPath) lines.push(buildBinPath);

  lines.push(`WORKDIR /workspace`, `COPY . /workspace`);

  // Monorepo workspace prepare: runs ONCE at /workspace (repo root)
  // before we cd into the sub-app and run the per-service install.
  // Any workspace-level prep — install, codegen, schema sync — chained
  // with `&&`. Wraps in its own RUN layer so docker can cache it across
  // sub-app rebuilds (most pushes only touch one sub-app).
  if (workspacePrepare) {
    // envPrefix already ends with ` && ` when non-empty, so no extra
    // separator is needed — adding one would produce a stray double
    // space inside the Dockerfile RUN line.
    lines.push(workspacePrepareRunLine(config, envPrefix, workspacePrepare));
  }

  lines.push(`WORKDIR ${sourceDir}`);

  // Single RUN for install+build - avoids costly Docker layer commits between steps.
  // Each step emits markers so the UI stepper can track progress.
  const stepsLine = installBuildRunLine(config, envPrefix);
  if (stepsLine) {
    lines.push(stepsLine);
  }
  const prepareOutput = prepareNodeOutputCommand(config);
  if (prepareOutput) lines.push(`RUN ${prepareOutput.replace(/\n/g, " ")}`);

  if (multiStage) {
    lines.push(...builderCompatibilityLines(config));
    lines.push(`FROM ${config.runtimeImage} AS runtime`);
    lines.push(...runtimeCompatibilityLines(config));
    lines.push(...runtimeCopyDirectives(config, sourceDir));
    if (prepareOutput && config.productionPaths?.length) lines.push(`COPY --from=builder ${sourceDir}/.openship-start.sh /app/.openship-start.sh`);
    lines.push(`WORKDIR /app`);
    // The copy retargets `sourceDir` → /app, so the runtime stage needs its own
    // ENV (ENV does not cross a FROM) pointing at the new location.
    const runtimeBinPath = nodeBinPathEnvLine(config.packageManager, ["/app"]);
    if (runtimeBinPath) lines.push(runtimeBinPath);
  }
  lines.push(...managedNodeDockerLines(config));
  if (prepareOutput) lines.push(`LABEL ${START_SOURCE_LABEL}=${JSON.stringify(startCommandDigest(config.startCommand))} ${START_COMMAND_LABEL}=${JSON.stringify(AUTOMATIC_START)}`);
  lines.push(`EXPOSE ${config.port}`);
  if (config.startCommand || prepareOutput) {
    lines.push(`CMD ["sh", "-c", ${JSON.stringify(prepareOutput ? AUTOMATIC_START : config.startCommand)}]`);
  }

  return lines.join("\n");
}
