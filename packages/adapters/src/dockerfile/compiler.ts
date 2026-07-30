import { parseDockerfile } from "./parser";
import type {
  CompileDockerfileOptions,
  DockerfileCommandForm,
  DockerfileInstruction,
  DockerfileParseResult,
  WorkspaceBuildPlan,
  WorkspaceBuildStagePlan,
  WorkspaceCommand,
  WorkspaceCopyStep,
  WorkspaceExposedPort,
  WorkspacePlanDiagnostic,
  WorkspaceRunStep,
} from "./types";

const DEFAULT_WORKDIR = "/";
const PATHLIKE_RE = /^[A-Za-z0-9_@%+=:,./-]+$/;

function diagnostic(
  instruction: DockerfileInstruction,
  severity: WorkspacePlanDiagnostic["severity"],
  message: string,
): WorkspacePlanDiagnostic {
  return {
    severity,
    instruction: instruction.keyword,
    line: instruction.line,
    message,
  };
}

function splitFirstEquals(value: string): [string, string | null] {
  const index = value.indexOf("=");
  if (index === -1) {
    return [value, null];
  }
  return [value.slice(0, index), value.slice(index + 1)];
}

function parseJsonArray(value: string): string[] | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[")) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed.map((part) => String(part));
  } catch {
    return null;
  }
}

function splitWords(value: string): string[] {
  const words: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (const char of value.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }

    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if (/\s/.test(char) && !inSingle && !inDouble) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaped) {
    current += "\\";
  }

  if (current) {
    words.push(current);
  }

  return words;
}

function shellQuote(value: string): string {
  if (PATHLIKE_RE.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function commandToShell(command: WorkspaceCommand): string {
  if (command.form === "exec") {
    return (command.value as string[]).map(shellQuote).join(" ");
  }
  return command.value as string;
}

function toWorkspaceCommand(instruction: DockerfileInstruction): WorkspaceCommand {
  const exec = parseJsonArray(instruction.value);
  if (exec) {
    return {
      form: "exec",
      value: exec,
      raw: instruction.value,
    };
  }

  return {
    form: "shell",
    value: instruction.value.trim(),
    raw: instruction.value,
  };
}

function combineStartCommand(
  entrypoint?: WorkspaceCommand,
  cmd?: WorkspaceCommand,
): string | undefined {
  if (!entrypoint && !cmd) {
    return undefined;
  }

  if (!entrypoint) {
    return commandToShell(cmd!);
  }

  if (!cmd) {
    return commandToShell(entrypoint);
  }

  // A shell-form ENTRYPOINT runs via `/bin/sh -c` and takes no CMD arguments.
  if (entrypoint.form === "shell") {
    return commandToShell(entrypoint);
  }

  const entrypointShell = commandToShell(entrypoint);
  const cmdShell = commandToShell(cmd);
  return cmdShell ? `${entrypointShell} ${cmdShell}` : entrypointShell;
}

function normalizeWorkdir(current: string, next: string): string {
  const value = next.trim();
  if (!value) {
    return current;
  }

  const raw = value.startsWith("/") ? value : `${current.replace(/\/+$/g, "")}/${value}`;
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function parseKeyValueList(value: string): Record<string, string> {
  const tokens = splitWords(value);
  const result: Record<string, string> = {};

  if (tokens.length === 0) {
    return result;
  }

  if (!tokens[0].includes("=") && tokens.length >= 2) {
    result[tokens[0]] = tokens.slice(1).join(" ");
    return result;
  }

  for (const token of tokens) {
    const [key, tokenValue] = splitFirstEquals(token);
    if (!key || tokenValue === null) {
      continue;
    }
    result[key] = tokenValue;
  }

  return result;
}

function parseFromInstruction(instruction: DockerfileInstruction): {
  baseImage: string;
  name?: string;
  platform?: string;
  diagnostic?: WorkspacePlanDiagnostic;
} {
  const parts = splitWords(instruction.value);
  const platformFlag = instruction.flags.platform;
  const platform = typeof platformFlag === "string" ? platformFlag : undefined;

  if (parts.length === 0) {
    return {
      baseImage: "",
      platform,
      diagnostic: diagnostic(instruction, "error", "FROM is missing a base image."),
    };
  }

  const baseImage = parts[0];
  let name: string | undefined;
  let warning: WorkspacePlanDiagnostic | undefined;

  if (parts.length >= 3 && parts[1]?.toUpperCase() === "AS") {
    name = parts[2];
    if (parts.length > 3) {
      warning = diagnostic(instruction, "warning", "Ignoring extra tokens after FROM stage alias.");
    }
  } else if (parts.length > 1) {
    warning = diagnostic(
      instruction,
      "warning",
      "FROM contains extra tokens that are not part of a stage alias.",
    );
  }

  return { baseImage, name, platform, diagnostic: warning };
}

function createStage(
  index: number,
  from: { baseImage: string; name?: string; platform?: string },
  defaultWorkdir: string,
): WorkspaceBuildStagePlan {
  return {
    index,
    name: from.name,
    baseImage: from.baseImage,
    platform: from.platform,
    workdir: defaultWorkdir,
    env: {},
    args: {},
    labels: {},
    copies: [],
    runs: [],
    steps: [],
    exposedPorts: [],
    unsupported: [],
  };
}

function parseCopyLikeInstruction(
  instruction: DockerfileInstruction,
  kind: "copy" | "add",
  workdir: string,
): { step?: WorkspaceCopyStep; diagnostics: WorkspacePlanDiagnostic[] } {
  const diagnostics: WorkspacePlanDiagnostic[] = [];
  const parts = parseJsonArray(instruction.value) ?? splitWords(instruction.value);

  if (parts.length < 2) {
    return {
      diagnostics: [
        diagnostic(
          instruction,
          "error",
          `${instruction.keyword} needs at least one source and one destination.`,
        ),
      ],
    };
  }

  const from = typeof instruction.flags.from === "string" ? instruction.flags.from : undefined;
  const sources = parts.slice(0, -1);
  const destination = parts[parts.length - 1] ?? "";

  if (kind === "add") {
    diagnostics.push(
      diagnostic(
        instruction,
        "warning",
        "ADD is recorded, but remote URLs and archive extraction need explicit workspace execution support.",
      ),
    );
  }

  for (const flag of ["chown", "chmod", "link"]) {
    if (instruction.flags[flag] !== undefined) {
      diagnostics.push(
        diagnostic(
          instruction,
          "warning",
          `${instruction.keyword} --${flag} is Docker-specific metadata and needs explicit workspace handling.`,
        ),
      );
    }
  }

  return {
    step: {
      kind,
      sources,
      destination,
      from,
      workdir,
      flags: instruction.flags,
      line: instruction.line,
      raw: instruction.value,
    },
    diagnostics,
  };
}

function parseExposeInstruction(instruction: DockerfileInstruction): {
  ports: WorkspaceExposedPort[];
  diagnostics: WorkspacePlanDiagnostic[];
} {
  const ports: WorkspaceExposedPort[] = [];
  const diagnostics: WorkspacePlanDiagnostic[] = [];

  for (const token of splitWords(instruction.value)) {
    const match = token.match(/^(\d+)(?:\/(tcp|udp))?$/i);
    if (!match) {
      diagnostics.push(
        diagnostic(instruction, "warning", `Could not parse EXPOSE value "${token}".`),
      );
      continue;
    }

    ports.push({
      port: Number(match[1]),
      protocol: (match[2]?.toLowerCase() as "tcp" | "udp" | undefined) ?? "tcp",
    });
  }

  return { ports, diagnostics };
}

function parseArgInstruction(
  instruction: DockerfileInstruction,
  buildArgs: Record<string, string>,
): { key?: string; value?: string | null; diagnostic?: WorkspacePlanDiagnostic } {
  const [rawKey, rawDefault] = splitFirstEquals(instruction.value.trim());
  const key = rawKey.trim();
  if (!key) {
    return {
      diagnostic: diagnostic(instruction, "warning", "ARG is missing a name."),
    };
  }

  return {
    key,
    value: buildArgs[key] ?? rawDefault,
  };
}

function currentOrDiagnostic(
  currentStage: WorkspaceBuildStagePlan | null,
  instruction: DockerfileInstruction,
): { stage?: WorkspaceBuildStagePlan; diagnostic?: WorkspacePlanDiagnostic } {
  if (currentStage) {
    return { stage: currentStage };
  }
  return {
    diagnostic: diagnostic(
      instruction,
      instruction.keyword === "ARG" ? "warning" : "error",
      `${instruction.keyword} appears before the first FROM stage.`,
    ),
  };
}

function selectFinalStage(
  stages: WorkspaceBuildStagePlan[],
  targetStage?: string,
): WorkspaceBuildStagePlan | null {
  if (stages.length === 0) {
    return null;
  }

  if (!targetStage) {
    return stages[stages.length - 1] ?? null;
  }

  return (
    stages.find((stage) => stage.name === targetStage || String(stage.index) === targetStage) ??
    null
  );
}

function isPreviousStageReference(
  stages: WorkspaceBuildStagePlan[],
  currentStage: WorkspaceBuildStagePlan,
  ref: string,
): boolean {
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === ref) {
    return numeric >= 0 && numeric < currentStage.index;
  }

  return stages.some((stage) => stage.index < currentStage.index && stage.name === ref);
}

function findPreviousStageReference(
  stages: WorkspaceBuildStagePlan[],
  ref: string,
): WorkspaceBuildStagePlan | null {
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === ref) {
    return stages[numeric] ?? null;
  }

  return stages.find((stage) => stage.name === ref) ?? null;
}

function inheritStageImageConfig(
  target: WorkspaceBuildStagePlan,
  base: WorkspaceBuildStagePlan,
): void {
  target.workdir = base.workdir;
  target.env = { ...base.env };
  target.labels = { ...base.labels };
  target.exposedPorts = [...base.exposedPorts];
  target.cmd = base.cmd;
  target.entrypoint = base.entrypoint;
  target.startCommand = base.startCommand;
  target.user = base.user;
  target.shell = base.shell ? [...base.shell] : undefined;
}

function validateStageArtifactCopies(stages: WorkspaceBuildStagePlan[]): WorkspacePlanDiagnostic[] {
  const diagnostics: WorkspacePlanDiagnostic[] = [];

  for (const stage of stages) {
    for (const copy of stage.copies) {
      if (!copy.from) continue;
      if (isPreviousStageReference(stages, stage, copy.from)) continue;

      diagnostics.push({
        severity: "unsupported",
        instruction: copy.kind === "copy" ? "COPY" : "ADD",
        line: copy.line,
        message: `${copy.kind.toUpperCase()} --from=${copy.from} references an external image, current stage, or later stage. Cloud Dockerfile builds currently support --from only for previous stages in the same Dockerfile.`,
      });
    }
  }

  return diagnostics;
}

export function compileDockerfileParseResult(
  parseResult: DockerfileParseResult,
  options: CompileDockerfileOptions = {},
): WorkspaceBuildPlan {
  const defaultWorkdir = normalizeWorkdir("/", options.defaultWorkdir ?? DEFAULT_WORKDIR);
  const buildArgs = options.buildArgs ?? {};
  const diagnostics: WorkspacePlanDiagnostic[] = [...parseResult.warnings];
  const globalArgs: Record<string, string | null> = {};
  const stages: WorkspaceBuildStagePlan[] = [];
  let currentStage: WorkspaceBuildStagePlan | null = null;

  for (const instruction of parseResult.instructions) {
    if (instruction.keyword === "ARG" && !currentStage) {
      const parsedArg = parseArgInstruction(instruction, buildArgs);
      if (parsedArg.diagnostic) {
        diagnostics.push(parsedArg.diagnostic);
        continue;
      }
      if (parsedArg.key) {
        globalArgs[parsedArg.key] = parsedArg.value ?? null;
      }
      continue;
    }

    if (instruction.keyword === "FROM") {
      const parsedFrom = parseFromInstruction(instruction);
      if (parsedFrom.diagnostic) {
        diagnostics.push(parsedFrom.diagnostic);
      }
      currentStage = createStage(stages.length, parsedFrom, defaultWorkdir);
      const baseStage = findPreviousStageReference(stages, parsedFrom.baseImage);
      if (baseStage) {
        inheritStageImageConfig(currentStage, baseStage);
      }
      stages.push(currentStage);
      continue;
    }

    const stageResult = currentOrDiagnostic(currentStage, instruction);
    if (!stageResult.stage) {
      if (stageResult.diagnostic) {
        diagnostics.push(stageResult.diagnostic);
      }
      continue;
    }

    const stage = stageResult.stage;

    switch (instruction.keyword) {
      case "ARG": {
        const parsedArg = parseArgInstruction(instruction, buildArgs);
        if (parsedArg.diagnostic) {
          diagnostics.push(parsedArg.diagnostic);
        } else if (parsedArg.key) {
          stage.args[parsedArg.key] = parsedArg.value ?? null;
        }
        break;
      }

      case "ENV":
        Object.assign(stage.env, parseKeyValueList(instruction.value));
        break;

      case "LABEL":
        Object.assign(stage.labels, parseKeyValueList(instruction.value));
        break;

      case "WORKDIR":
        stage.workdir = normalizeWorkdir(stage.workdir, instruction.value);
        break;

      case "COPY":
      case "ADD": {
        const parsedCopy = parseCopyLikeInstruction(
          instruction,
          instruction.keyword === "COPY" ? "copy" : "add",
          stage.workdir,
        );
        if (parsedCopy.step) {
          stage.copies.push(parsedCopy.step);
          stage.steps.push({ type: "copy", copy: parsedCopy.step });
        }
        diagnostics.push(...parsedCopy.diagnostics);
        break;
      }

      case "RUN": {
        const command = toWorkspaceCommand(instruction);
        const runStep: WorkspaceRunStep = {
          command: commandToShell(command),
          form: command.form as DockerfileCommandForm,
          workdir: stage.workdir,
          env: { ...stage.env },
          args: { ...stage.args },
          flags: instruction.flags,
          line: instruction.line,
          raw: instruction.value,
        };
        if (command.form === "exec") {
          runStep.exec = command.value as string[];
        }
        stage.runs.push(runStep);
        stage.steps.push({ type: "run", run: runStep });

        for (const flag of Object.keys(instruction.flags)) {
          diagnostics.push(
            diagnostic(
              instruction,
              "warning",
              `RUN --${flag} is a Docker BuildKit feature and needs explicit workspace support.`,
            ),
          );
        }
        break;
      }

      case "EXPOSE": {
        const exposed = parseExposeInstruction(instruction);
        stage.exposedPorts.push(...exposed.ports);
        diagnostics.push(...exposed.diagnostics);
        break;
      }

      case "CMD":
        stage.cmd = toWorkspaceCommand(instruction);
        stage.startCommand = combineStartCommand(stage.entrypoint, stage.cmd);
        break;

      case "ENTRYPOINT":
        stage.entrypoint = toWorkspaceCommand(instruction);
        stage.startCommand = combineStartCommand(stage.entrypoint, stage.cmd);
        break;

      case "USER":
        stage.user = instruction.value.trim();
        break;

      case "SHELL": {
        const shell = parseJsonArray(instruction.value);
        if (shell) {
          stage.shell = shell;
          diagnostics.push(
            diagnostic(
              instruction,
              "warning",
              "SHELL changes how later shell-form RUN/CMD instructions execute; the plan records it but does not emulate shell behavior.",
            ),
          );
        } else {
          const item = diagnostic(
            instruction,
            "unsupported",
            "SHELL must use JSON array form to be planned.",
          );
          diagnostics.push(item);
          stage.unsupported.push(item);
        }
        break;
      }

      case "HEALTHCHECK":
      case "ONBUILD":
      case "STOPSIGNAL":
      case "VOLUME": {
        const item = diagnostic(
          instruction,
          "unsupported",
          `${instruction.keyword} is runtime/image metadata and cannot be represented as workspace build commands yet.`,
        );
        diagnostics.push(item);
        stage.unsupported.push(item);
        break;
      }

      case "MAINTAINER":
        diagnostics.push(
          diagnostic(
            instruction,
            "warning",
            "MAINTAINER is deprecated and ignored by the workspace plan.",
          ),
        );
        break;

      case "OTHER": {
        const item = diagnostic(
          instruction,
          "unsupported",
          `Unsupported Dockerfile instruction "${instruction.originalKeyword}".`,
        );
        diagnostics.push(item);
        stage.unsupported.push(item);
        break;
      }
    }
  }

  if (stages.length === 0) {
    diagnostics.push({
      severity: "error",
      message: "Dockerfile does not contain a FROM instruction.",
    });
  }

  const finalStage = selectFinalStage(stages, options.targetStage);
  if (options.targetStage && !finalStage) {
    diagnostics.push({
      severity: "error",
      message: `Target Dockerfile stage "${options.targetStage}" was not found.`,
    });
  }

  diagnostics.push(...validateStageArtifactCopies(stages));

  const runtime = finalStage
    ? {
        baseImage: finalStage.baseImage,
        workdir: finalStage.workdir,
        env: { ...finalStage.env },
        exposedPort: finalStage.exposedPorts[0]?.port,
        exposedPorts: [...finalStage.exposedPorts],
        startCommand: finalStage.startCommand,
        user: finalStage.user,
      }
    : null;

  const hasStageArtifactCopies = stages.some((stage) => stage.copies.some((copy) => copy.from));
  const requiresDockerSemantics =
    diagnostics.some((item) => item.severity === "unsupported") ||
    stages.length > 1 ||
    hasStageArtifactCopies;

  return {
    source: "dockerfile",
    globalArgs,
    stages,
    finalStage,
    runtime,
    diagnostics,
    isMultiStage: stages.length > 1,
    requiresDockerSemantics,
  };
}

export function compileDockerfileToWorkspacePlan(
  source: string,
  options?: CompileDockerfileOptions,
): WorkspaceBuildPlan {
  return compileDockerfileParseResult(parseDockerfile(source), options);
}
