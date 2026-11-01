import type { AppLocale } from "@repo/core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, realpath, writeFile, rename } from "node:fs/promises";
import { constants } from "node:fs";
import { join, delimiter, posix } from "node:path";
import {
  OPENSHIP_TOOL_INSTRUCTIONS,
  OPENSHIP_CHAT_INSTRUCTIONS,
  ASSISTANT_PROVIDER_LABELS,
  type AssistantProvider,
} from "@repo/contracts";
import type { TurnOptions } from "mindwire";
import { CODEX_GUARD } from "./codex-guard";

const exec = promisify(execFile);
export const HARNESS = {
  claude: {
    agent: "claude-code",
    name: ASSISTANT_PROVIDER_LABELS.claude,
    binary: "claude",
    package: "@anthropic-ai/claude-code",
  },
  codex: {
    agent: "codex",
    name: ASSISTANT_PROVIDER_LABELS.codex,
    binary: "codex",
    package: "@openai/codex",
  },
} as const;
export const PROVIDERS = Object.keys(HARNESS) as AssistantProvider[];
export const SAFE_SETTINGS = new Set(["model", "reasoningEffort", "reasoningSummary", "verbosity"]);
export interface HarnessProbe {
  provider: AssistantProvider;
  path?: string;
  version: string;
  available: boolean;
  issue?: string;
  flags: string[];
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Deliberately excludes host API/database secrets, SSH agents, preload hooks and global agent config. */
export function assistantEnvironment(directory: string, path: string): NodeJS.ProcessEnv {
  return {
    PATH: path,
    HOME: posix.join(directory, "home"),
    CODEX_HOME: posix.join(directory, "home", ".codex"),
    CLAUDE_CONFIG_DIR: posix.join(directory, "home", ".claude"),
    XDG_CONFIG_HOME: posix.join(directory, "home", ".config"),
    XDG_DATA_HOME: posix.join(directory, "home", ".local", "share"),
    XDG_CACHE_HOME: posix.join(directory, "cache"),
    TMPDIR: posix.join(directory, "tmp"),
    TMP: posix.join(directory, "tmp"),
    TEMP: posix.join(directory, "tmp"),
    MINDWIRE_TOOLCHAIN_DIR: posix.join(directory, "toolchains"),
    SHELL: "/bin/bash",
    LANG: "en_US.UTF-8",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    BROWSER: "true",
    NO_COLOR: "1",
    ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
  };
}

/** Native capabilities default off; the Code Mode host only dispatches the remaining scoped tools. */
export function codexToolFlags(listing: string): string[] {
  const features = listing
    .trim()
    .split("\n")
    .map((line) => /^([\w.]+)\s+(.+?)\s+(true|false)\s*$/.exec(line))
    .filter((m) => m !== null);
  for (const key of [
    "shell_tool",
    "unified_exec",
    "view_image",
    "hooks",
    "plugins",
    "multi_agent",
    "skip_host_skill_discovery",
    "code_mode_host",
  ])
    if (!features.some((m) => m[1] === key)) throw new Error("Unsupported Codex tool policy.");
  return [
    ...features
      .filter(
        (m) =>
          !["removed", "deprecated"].includes(m[2]!) &&
          !["skip_host_skill_discovery", "code_mode_host"].includes(m[1]!),
      )
      .flatMap((m) => ["--disable", m[1]!]),
    "--enable",
    "skip_host_skill_discovery",
    // Models using Code Mode route even MCP calls through this sandboxed runtime.
    // Disabling it advertises exec but makes every invocation fail before reaching OpenShip.
    "--enable",
    "code_mode_host",
    "-c",
    "agents.enabled=false",
    "-c",
    'web_search="disabled"',
    "-c",
    'sandbox_mode="read-only"',
    "-c",
    'approval_policy="never"',
    // Codex validates the transport even for a disabled server, before thread overrides arrive.
    "-c",
    'mcp_servers.mindwire_desktop.url="http://127.0.0.1:1/disabled"',
    "-c",
    "mcp_servers.mindwire_desktop.enabled=false",
  ];
}
export async function probeHarness(
  provider: AssistantProvider,
  searchPath: string,
  env: NodeJS.ProcessEnv,
): Promise<HarnessProbe> {
  const spec = HARNESS[provider];
  let path: string | undefined;
  for (const directory of searchPath.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, spec.binary);
    try {
      await access(candidate, constants.X_OK);
      path = await realpath(candidate);
      break;
    } catch {
      /* Next PATH entry. */
    }
  }
  return inspectHarness(
    provider,
    path,
    async (args) => (await exec(path!, args, { env, timeout: 10000, maxBuffer: 256000 })).stdout,
  );
}

/** Same capability policy on local and remote hosts; only command transport differs. */
export async function inspectHarness(
  provider: AssistantProvider,
  path: string | undefined,
  run: (args: string[]) => Promise<string>,
): Promise<HarnessProbe> {
  const spec = HARNESS[provider];
  const unavailable = (issue: string, version = ""): HarnessProbe => ({
    provider,
    path,
    version,
    available: false,
    issue,
    flags: [],
  });
  if (!path) return unavailable(`Install ${spec.name} on the assistant host, then check again.`);
  try {
    const versionOutput = await run(["--version"]);
    const version = /\b(\d+\.\d+\.\d+)\b/.exec(versionOutput)?.[1] ?? "";
    // Mindwire owns harness compatibility; only inspect the capabilities needed for workspace scope.
    const help = await run(["--help"]);
    let flags: string[];
    if (provider === "codex") {
      const listed = await run(["features", "list"]);
      flags = codexToolFlags(listed);
      const configured = await run(["mcp", "list", "--json"]);
      const servers: unknown = JSON.parse(configured);
      if (!Array.isArray(servers) || servers.length)
        return unavailable(
          "This Codex installation adds external MCP servers. OpenShip requires a profile containing only its scoped workspace tools.",
          version,
        );
    } else {
      for (const flag of [
        "--tools",
        "--strict-mcp-config",
        "--setting-sources",
        "--disable-slash-commands",
        "--no-chrome",
      ])
        if (!help.includes(flag))
          return unavailable("This Claude installation does not support scoped tools.", version);
      flags = [
        "--tools",
        "AskUserQuestion",
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--disable-slash-commands",
        "--no-chrome",
        "--disallowedTools",
        "mcp__mindwire_desktop__*",
      ];
    }
    return { provider, path, version, available: true, flags };
  } catch {
    return unavailable(`Could not inspect ${spec.name}. Check its installation and try again.`);
  }
}

/** Wrappers are private, host-owned policy. Neither the user prompt nor an agent setting supplies argv. */
export async function writeHarnessWrapper(directory: string, probe: HarnessProbe) {
  const filename = join(directory, HARNESS[probe.provider].binary);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const guard = join(directory, "codex-guard.mjs");
  if (probe.provider === "codex") {
    const pending = `${guard}.${crypto.randomUUID()}`;
    await writeFile(pending, CODEX_GUARD, { mode: 0o600 });
    await rename(pending, guard);
  }
  const script = harnessWrapper(directory, probe);
  const temporary = `${filename}.${crypto.randomUUID()}`;
  await writeFile(temporary, script, { mode: 0o700 });
  await rename(temporary, filename);
}

/** Policy source is shared by local and remote provisioning, including the exact native flags. */
export function harnessWrapper(directory: string, probe: HarnessProbe, node = process.execPath) {
  const guard = posix.join(directory, "codex-guard.mjs");
  let script = "#!/bin/bash\nset -e\n";
  if (!probe.path || !probe.available)
    script += 'echo "This harness is unavailable for OpenShip scoped tools." >&2\nexit 78\n';
  else {
    const binary = quote(probe.path);
    script +=
      probe.provider === "codex"
        ? 'openship_native_turn=false\ncase "${1:-}" in app-server|exec) openship_native_turn=true;; esac\n'
        : 'openship_native_turn=false\nfor openship_arg in "$@"; do case "$openship_arg" in -p|--print|--input-format) openship_native_turn=true;; esac; done\n';
    const guarded =
      probe.provider === "codex"
        ? `  if [[ "${"${1:-}"}" == app-server ]]; then exec ${quote(node)} ${quote(guard)} ${binary} ${probe.flags.map(quote).join(" ")} "$@"; fi\n`
        : "";
    script += `if "$openship_native_turn"; then\n${guarded}  exec ${binary} ${probe.flags.map(quote).join(" ")} "$@"\nfi\nexec ${binary} "$@"\n`;
  }
  return script;
}

export function scopedTurnOptions(
  provider: AssistantProvider,
  bridge: { url: string; token: string },
  model: string,
  chat = false,
  locale: AppLocale = "en",
): TurnOptions {
  const headers = { Authorization: `Bearer ${bridge.token}` };
  return {
    systemPrompt:
      OPENSHIP_TOOL_INSTRUCTIONS +
      (chat ? `\n\n${OPENSHIP_CHAT_INSTRUCTIONS}` : "") +
      `\n\nThe user’s OpenShip language is ${locale}. Reply in that language unless the user asks otherwise. Keep command syntax, identifiers and code unchanged.`,
    settings: {
      ...(model ? { model } : {}),
      ...(provider === "codex"
        ? { permissionMode: "never", sandbox: "read-only" }
        : {
            permissionMode: "dontAsk",
            allowedTools: "AskUserQuestion",
            allowRules: "mcp__openship__* AskUserQuestion",
          }),
    },
    mcpServers: {
      mcpServers: {
        openship:
          provider === "claude"
            ? { type: "http", url: bridge.url, headers }
            : { url: bridge.url, httpHeaders: headers, defaultToolsApprovalMode: "auto" },
      },
    },
    ...(provider === "claude"
      ? {
          claudeSettings: {
            disableAllHooks: true,
            enabledPlugins: {},
            permissions: {
              allow: ["mcp__openship__*", "AskUserQuestion"],
              deny: ["mcp__mindwire_desktop__*"],
            },
          },
        }
      : {}),
  };
}
