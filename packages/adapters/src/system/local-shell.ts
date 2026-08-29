import { execFile } from "node:child_process";
import { shellQuote } from "@repo/core";
import { basename } from "node:path";

import type { LogEntry } from "../types";

const LOCAL_BUILD_ENV_KEYS = [
  "HOME",
  "PATH",
  "SHELL",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GIT_SSH_COMMAND",
  "GIT_ASKPASS",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
] as const;

/** Alias of `@repo/core`'s {@link shellQuote}. Kept as a name because ~300 call sites in
 *  this package read `sq(...)`; there is one implementation, in core. */
export const sq = shellQuote;

export function logEntry(
  message: string,
  level: LogEntry["level"] = "info",
  rawData?: string,
): LogEntry {
  // rawData = base64 of the UNTOUCHED bytes for this chunk. When set, the SSE
  // forwards it verbatim to the client's xterm, so carriage returns / ANSI are
  // preserved and progress lines (git, npm, next build) repaint in place
  // instead of flooding new lines. Omitted for synthesized (non-stream) entries.
  return { timestamp: new Date().toISOString(), message, level, ...(rawData ? { rawData } : {}) };
}

export function getLocalShellPath(): string {
  return process.env.SHELL?.trim() || "/bin/sh";
}

export function getLocalShellArgs(command: string): string[] {
  const shellName = basename(getLocalShellPath());

  if (shellName === "bash" || shellName === "zsh") {
    return ["-lc", command];
  }

  return ["-c", command];
}

export function getLocalExecEnv(): NodeJS.ProcessEnv {
  return { ...process.env, DEBIAN_FRONTEND: "noninteractive", DPKG_FORCE: "confnew" };
}

async function execFileText(
  command: string,
  args: string[],
  timeout = 5_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim() || stdout.trim() || err.message));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export async function hasLocalCommand(command: string): Promise<boolean> {
  try {
    await execFileText("sh", ["-c", `command -v ${command} >/dev/null 2>&1 && echo ok`], 4_000);
    return true;
  } catch {
    return false;
  }
}

export function emitBufferedLines(
  chunk: Buffer,
  state: { partial: string },
  onLine: (line: string) => void,
): void {
  const text = `${state.partial}${chunk.toString()}`.replace(/\r/g, "\n");
  const parts = text.split("\n");
  state.partial = parts.pop() ?? "";

  for (const raw of parts) {
    const line = raw.trimEnd();
    if (line) {
      onLine(line);
    }
  }
}

export function flushBufferedLines(
  state: { partial: string },
  onLine: (line: string) => void,
): void {
  const line = state.partial.trimEnd();
  state.partial = "";
  if (line) {
    onLine(line);
  }
}

function buildIsolatedLocalEnv(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { DEBIAN_FRONTEND: "noninteractive", DPKG_FORCE: "confnew" };

  for (const key of LOCAL_BUILD_ENV_KEYS) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }

  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (typeof value === "string") {
        env[key] = value;
      }
    }
  }

  return env;
}

export function wrapLocalBuildCommand(command: string, envOverrides?: NodeJS.ProcessEnv): string {
  const shellPath = getLocalShellPath();
  const envVars = buildIsolatedLocalEnv(envOverrides);
  const envAssignments = Object.entries(envVars)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => `${key}=${sq(value)}`)
    .join(" ");

  return `env -i ${envAssignments} ${sq(shellPath)} ${getLocalShellArgs(command).map(sq).join(" ")}`;
}