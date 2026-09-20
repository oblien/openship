/**
 * Docker-build failure diagnostics and inactivity handling shared by the
 * Engine-API and SSH/CLI build paths.
 *
 * Keep this module daemon-agnostic. In particular, memory pressure is not
 * inferred by scanning host containers: without an authoritative container id,
 * that can target an unrelated workload. Exit signals and explicit allocator
 * errors are evidence; a high memory percentage by itself is not.
 */

export const DEFAULT_DOCKER_BUILD_IDLE_TIMEOUT_MS = 10 * 60_000;
export const MIN_DOCKER_BUILD_IDLE_TIMEOUT_MS = 60_000;
export const MAX_DOCKER_BUILD_IDLE_TIMEOUT_MS = 24 * 60 * 60_000;

/**
 * Resolve the one operator-facing build inactivity setting.
 *
 * Invalid and unsafe values fall back to the documented default instead of
 * accidentally disabling the guard or turning a typo into an immediate abort.
 */
export function getDockerBuildIdleTimeoutMs(
  raw = process.env.OPENSHIP_BUILD_IDLE_TIMEOUT_MS,
): number {
  if (raw == null || raw.trim() === "") return DEFAULT_DOCKER_BUILD_IDLE_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isSafeInteger(value) &&
    value >= MIN_DOCKER_BUILD_IDLE_TIMEOUT_MS &&
    value <= MAX_DOCKER_BUILD_IDLE_TIMEOUT_MS
    ? value
    : DEFAULT_DOCKER_BUILD_IDLE_TIMEOUT_MS;
}

export interface DockerBuildDiagnosticContext {
  /** The limit selected in OpenShip, when one was selected. */
  configuredMemoryMb?: number;
  /** True only when this particular builder actually received that limit. */
  memoryLimitApplied?: boolean;
}

function memoryGuidance(context: DockerBuildDiagnosticContext): string {
  const memoryMb = context.configuredMemoryMb;
  if (context.memoryLimitApplied && memoryMb && memoryMb > 0) {
    return `The classic Docker builder was capped at ${memoryMb} MB RAM; raise Build Memory in Project Settings → Resources if this build needs more.`;
  }
  return "This build path was not under an OpenShip-enforced memory cap; check available RAM/swap and the host or Docker daemon OOM logs.";
}

function findNonZeroExitCode(output: string): number | null {
  for (const match of output.matchAll(
    /(?:returned a non-zero code|exit(?:ed)? with(?: exit)? code|exit code)\s*:?\s*(\d+)\b/gi,
  )) {
    const code = Number(match[1]);
    if (code !== 0) return code;
  }
  return null;
}

/**
 * Turn Docker/compiler output into a useful failure hint while preserving the raw
 * line. Exit 137 is described as SIGKILL and a likely OOM, never as proof of
 * OOM: an operator or another supervisor can also send SIGKILL.
 */
export function extractDockerBuildFailureHint(
  line: string,
  context: DockerBuildDiagnosticContext = {},
): string | null {
  const code = findNonZeroExitCode(line);
  if (code === 137) {
    return `${line} — The build process was killed by SIGKILL (exit code 137). Memory exhaustion is the most common cause, but exit 137 alone does not prove OOM. ${memoryGuidance(context)}`;
  }
  if (code === 143) {
    return `${line} — The build process received SIGTERM (exit code 143), usually because it was cancelled or stopped by another supervisor.`;
  }
  if (code !== null) return line;

  if (
    /JavaScript heap out of memory|Fatal process out of memory|Ineffective mark-compacts near heap limit|Reached heap limit Allocation failed|fatal error:\s*(?:runtime:\s*)?out of memory/i.test(
      line,
    )
  ) {
    return `${line} — The build process explicitly reported that it ran out of memory. ${memoryGuidance(context)}`;
  }

  if (/\bENOMEM\b|cannot allocate memory/i.test(line)) {
    return `${line} — The build process could not allocate memory (ENOMEM). ${memoryGuidance(context)}`;
  }

  return null;
}

/** Prefer root-cause evidence over a later generic Docker wrapper error. */
export function chooseDockerBuildFailureHint(
  current: string | null,
  candidate: string | null,
): string | null {
  if (!candidate) return current;
  if (!current) return candidate;

  const score = (message: string): number => {
    if (/explicitly reported that it ran out of memory|could not allocate memory/i.test(message)) {
      return 4;
    }
    if (/SIGKILL \(exit code 137\)/i.test(message)) return 3;
    if (/BuildKit|package\.json was not found/i.test(message)) return 2;
    if (
      /returned a non-zero code|failed to solve|executor failed running|error: build/i.test(message)
    ) {
      return 1;
    }
    return 0;
  };

  return score(candidate) > score(current) ? candidate : current;
}

/** Final SSH/CLI error, reusing any stronger evidence seen in streamed output. */
export function dockerBuildExitMessage(
  code: number,
  streamedHint: string | null,
  context: DockerBuildDiagnosticContext = {},
): string {
  if (streamedHint) return streamedHint;
  const plain = `docker build exited with code ${code}`;
  return extractDockerBuildFailureHint(plain, context) ?? plain;
}

function formatDuration(ms: number): string {
  if (ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const seconds = Math.ceil(ms / 1000);
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

export function dockerBuildIdleTimeoutError(
  timeoutMs: number,
  context: DockerBuildDiagnosticContext = {},
): Error {
  const limit =
    context.memoryLimitApplied && context.configuredMemoryMb && context.configuredMemoryMb > 0
      ? ` The classic Docker builder was capped at ${context.configuredMemoryMb} MB RAM, so sustained memory pressure is one possible cause.`
      : "";
  return new Error(
    `Docker build produced no output for ${formatDuration(timeoutMs)} and was cancelled.${limit} Other common causes are package-registry or DNS failures, a process waiting for input, and a stalled Docker daemon.`,
  );
}

export interface DockerBuildIdleMonitor {
  /** Record real output/progress and re-arm the inactivity deadline. */
  progress(): void;
  /** Permanently release both timers. Idempotent. */
  stop(): void;
}

/**
 * A single inactivity implementation for both Docker transports. It reports
 * elapsed time from the last real progress event (not timer tick counts), so
 * delayed event loops cannot produce misleading durations.
 */
export function startDockerBuildIdleMonitor(options: {
  timeoutMs: number;
  onIdle: (idleMs: number) => void;
  onTimeout: () => void;
}): DockerBuildIdleMonitor {
  let stopped = false;
  let lastProgressAt = Date.now();
  let lastReportedMinute = 0;
  let deadline: ReturnType<typeof setTimeout>;

  const armDeadline = () => {
    clearTimeout(deadline);
    deadline = setTimeout(() => {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeat);
      options.onTimeout();
    }, options.timeoutMs);
    deadline.unref?.();
  };

  const heartbeat = setInterval(() => {
    if (stopped) return;
    const idleMs = Date.now() - lastProgressAt;
    const idleMinutes = Math.floor(idleMs / 60_000);
    if (idleMinutes > lastReportedMinute) {
      lastReportedMinute = idleMinutes;
      options.onIdle(idleMs);
    }
  }, 60_000);
  heartbeat.unref?.();
  armDeadline();

  return {
    progress() {
      if (stopped) return;
      lastProgressAt = Date.now();
      lastReportedMinute = 0;
      armDeadline();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(deadline);
      clearInterval(heartbeat);
    },
  };
}
