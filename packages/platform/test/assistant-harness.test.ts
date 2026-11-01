import { expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
import type { AssistantProvider } from "@repo/contracts";
import {
  assistantEnvironment,
  probeHarness,
  writeHarnessWrapper,
} from "../src/engine/modules/assistant/harness-policy";

const codexFeatures = [
  "shell_tool stable true",
  "unified_exec stable true",
  "view_image stable true",
  "hooks experimental true",
  "plugins experimental true",
  "multi_agent experimental true",
  "skip_host_skill_discovery experimental false",
  "code_mode_host experimental true",
  "future_native_tool experimental true",
].join("\n");
const claudeHelp =
  "--tools --strict-mcp-config --setting-sources --disable-slash-commands --no-chrome";

async function harnessFixture(
  provider: AssistantProvider,
  version: string,
  options: { features?: string; help?: string; servers?: unknown[] } = {},
) {
  const directory = await mkdtemp("/tmp/openship-harness-policy-");
  const bin = join(directory, "bin");
  const state = join(directory, "fixture.json");
  const wrapper = join(directory, "wrapper");
  const config = { version, features: codexFeatures, help: claudeHelp, servers: [], ...options };
  await mkdir(bin);
  await writeFile(state, JSON.stringify(config));
  // This executable only prints fixture metadata and argv.
  // It cannot start an installed harness, authenticate, or contact a model endpoint.
  await writeFile(
    join(bin, provider),
    `#!${process.execPath}
import { readFileSync } from 'node:fs'
const config = JSON.parse(readFileSync(${JSON.stringify(state)}, 'utf8'))
const args = process.argv.slice(2)
if (args[0] === '--version') console.log(${JSON.stringify(provider)} + ' ' + config.version)
else if (args[0] === '--help') console.log(config.help)
else if (args[0] === 'features') console.log(config.features)
else if (args[0] === 'mcp') console.log(JSON.stringify(config.servers))
else console.log(JSON.stringify({ version: config.version, args }))
`,
    { mode: 0o700 },
  );
  const env = assistantEnvironment(directory, bin);
  return {
    directory,
    bin,
    wrapper,
    env,
    probe: () => probeHarness(provider, bin, env),
    upgrade: (version: string) => writeFile(state, JSON.stringify({ ...config, version })),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

async function invokeWrapper(
  fixture: Awaited<ReturnType<typeof harnessFixture>>,
  provider: AssistantProvider,
  args: string[],
) {
  const { stdout } = await exec(join(fixture.wrapper, provider), args, { env: fixture.env });
  return JSON.parse(stdout) as { version: string; args: string[] };
}

for (const version of ["0.162.1", "99.0.0"])
  test(`Codex ${version} is available when the required scoped capabilities exist`, async () => {
    const fixture = await harnessFixture("codex", version);
    try {
      const probe = await fixture.probe();
      expect(probe).toMatchObject({ provider: "codex", available: true, version });
      expect(probe.issue).toBeUndefined();
      expect(probe.flags).toEqual(
        expect.arrayContaining([
          "--disable",
          "shell_tool",
          "unified_exec",
          "future_native_tool",
          "skip_host_skill_discovery",
          "code_mode_host",
          'sandbox_mode="read-only"',
          'approval_policy="never"',
        ]),
      );
    } finally {
      await fixture.close();
    }
  });

for (const version of ["2.2.0", "99.0.0"])
  test(`Claude ${version} is available when the required scoped capabilities exist`, async () => {
    const fixture = await harnessFixture("claude", version);
    try {
      const probe = await fixture.probe();
      expect(probe).toMatchObject({ provider: "claude", available: true, version });
      expect(probe.issue).toBeUndefined();
      expect(probe.flags).toEqual(
        expect.arrayContaining([
          "--tools",
          "AskUserQuestion",
          "--strict-mcp-config",
          "--setting-sources",
          "--disable-slash-commands",
          "--no-chrome",
        ]),
      );
    } finally {
      await fixture.close();
    }
  });

for (const provider of ["codex", "claude"] as const)
  test(`a missing ${provider} executable is still unavailable`, async () => {
    const fixture = await harnessFixture(provider, "99.0.0");
    try {
      await rm(join(fixture.bin, provider));
      const probe = await fixture.probe();
      expect(probe.available).toBe(false);
      expect(probe.path).toBeUndefined();
      expect(probe.issue).toContain("Install");
      expect(probe.flags).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

test("a future Codex without required scoped features remains unavailable", async () => {
  const fixture = await harnessFixture("codex", "99.0.0", {
    features: codexFeatures.replace("shell_tool stable true\n", ""),
  });
  try {
    const probe = await fixture.probe();
    expect(probe.available).toBe(false);
    expect(probe.issue).toContain("Could not inspect Codex");
    expect(probe.flags).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("a future Claude without scoped MCP configuration remains unavailable", async () => {
  const fixture = await harnessFixture("claude", "99.0.0", {
    help: claudeHelp.replace("--strict-mcp-config", ""),
  });
  try {
    const probe = await fixture.probe();
    expect(probe).toMatchObject({ available: false, version: "99.0.0", flags: [] });
    expect(probe.issue).toContain("does not support scoped tools");
  } finally {
    await fixture.close();
  }
});

test("a future Codex with external MCP servers remains unavailable", async () => {
  const fixture = await harnessFixture("codex", "99.0.0", {
    servers: [{ name: "external", command: "fixture-only" }],
  });
  try {
    const probe = await fixture.probe();
    expect(probe).toMatchObject({ available: false, version: "99.0.0", flags: [] });
    expect(probe.issue).toContain("external MCP servers");
  } finally {
    await fixture.close();
  }
});

for (const provider of ["codex", "claude"] as const)
  test(`${provider} native wrapper keeps scoped flags after the installed version changes`, async () => {
    const fixture = await harnessFixture(provider, provider === "codex" ? "0.162.1" : "2.2.0");
    try {
      const probe = await fixture.probe();
      expect(probe.available, probe.issue).toBe(true);
      await writeHarnessWrapper(fixture.wrapper, probe);
      await fixture.upgrade("99.0.0");
      const args = provider === "codex" ? ["exec", "--json", "fixture"] : ["--print", "fixture"];
      const result = await invokeWrapper(fixture, provider, args);
      expect(result.version).toBe("99.0.0");
      expect(result.args).toEqual([...probe.flags, ...args]);
      // Discovery/auth commands remain native, without turn-only permission arguments.
      const { stdout: version } = await exec(join(fixture.wrapper, provider), ["--version"], {
        env: fixture.env,
      });
      expect(version.trim()).toBe(`${provider} 99.0.0`);
    } finally {
      await fixture.close();
    }
  });

import { spawn } from "node:child_process";
import { CODEX_GUARD } from "../src/engine/modules/assistant/codex-guard";
test("Node guard strips external MCP, dynamic tools and permission changes before native execution", async () => {
  const directory = await mkdtemp("/tmp/openship-native-guard-");
  try {
    const guard = join(directory, "guard.mjs"),
      echo = join(directory, "echo.mjs");
    await writeFile(guard, CODEX_GUARD);
    await writeFile(
      echo,
      `let s='';for await(const c of process.stdin)s+=c;process.stdout.write(s)`,
    );
    const child = spawn(process.execPath, [guard, process.execPath, echo], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "",
      error = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (error += chunk));
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    const messages = [
      {
        id: 1,
        method: "thread/start",
        params: {
          dynamicTools: [{ name: "shell" }],
          approvalPolicy: "never-ask",
          config: {
            sandbox_mode: "danger-full-access",
            plugins: ["evil"],
            mcp_servers: {
              openship: {
                url: "http://127.0.0.1:1234/mcp",
                http_headers: { Authorization: "Bearer fixture" },
              },
              external: { command: "sh" },
            },
          },
        },
      },
      { id: 2, method: "command/exec", params: { command: "never-executed" } },
      { id: 3, method: "fs/readFile", params: { path: "/never-read" } },
      { id: 4, method: "config/value/write", params: {} },
      {
        id: 5,
        method: "thread/resume",
        params: {
          config: {
            mcp_servers: {
              openship: {
                url: "https://example.com/mcp",
                http_headers: { Authorization: "Bearer fixture" },
              },
            },
          },
        },
      },
    ];
    child.stdin.end(messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
    expect(await exited, error).toBe(0);
    const replies = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const forwarded = replies.find((r) => r.id === 1);
    expect(forwarded.params.dynamicTools).toBeUndefined();
    expect(forwarded.params.approvalPolicy).toBe("never");
    expect(forwarded.params.sandbox).toBe("read-only");
    expect(Object.keys(forwarded.params.config).sort()).toEqual(["agents", "mcp_servers"]);
    expect(forwarded.params.config.mcp_servers.external).toBeUndefined();
    expect(forwarded.params.config.mcp_servers.mindwire_desktop.enabled).toBe(false);
    expect(forwarded.params.config.mcp_servers.openship.url).toBe("http://127.0.0.1:1234/mcp");
    for (const id of [2, 3, 4, 5])
      expect(replies.find((r) => r.id === id)).toMatchObject({ error: { code: -32601 } });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("child environment contains no inherited service credentials, preload hooks or SSH agent", () => {
  const env = assistantEnvironment("/tmp/scoped-fixture", "/usr/bin");
  for (const key of [
    "DATABASE_URL",
    "BETTER_AUTH_SECRET",
    "STRIPE_SECRET_KEY",
    "INTERNAL_TOKEN",
    "NODE_OPTIONS",
    "SSH_AUTH_SOCK",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
  ])
    expect(env).not.toHaveProperty(key);
  expect(env.HOME).toBe("/tmp/scoped-fixture/home");
});

test("remote Codex guard accepts only the exact configured HTTPS MCP endpoint", async () => {
  const directory = await mkdtemp("/tmp/openship-remote-guard-");
  try {
    const guard = join(directory, "guard.mjs"),
      echo = join(directory, "echo.mjs");
    await writeFile(guard, CODEX_GUARD);
    await writeFile(echo, "for await (const chunk of process.stdin) process.stdout.write(chunk)");
    const expected = "https://cloud.example.test/api/mcp";
    const child = spawn(process.execPath, [guard, process.execPath, echo], {
      env: {
        ...assistantEnvironment(directory, "/usr/bin:/bin"),
        OPENSHIP_ASSISTANT_MCP_URL: expected,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    const urls = [
      expected,
      "https://other.example.test/api/mcp",
      "http://cloud.example.test/api/mcp",
      "http://127.0.0.1:4200/mcp",
      `${expected}?token=leak`,
    ];
    child.stdin.end(
      urls
        .map((url, id) =>
          JSON.stringify({
            id,
            method: "thread/start",
            params: {
              config: {
                mcp_servers: {
                  openship: { url, http_headers: { Authorization: "Bearer fixture" } },
                },
              },
            },
          }),
        )
        .join("\n") + "\n",
    );
    expect(await exited).toBe(0);
    const messages = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(messages.find((m) => m.id === 0).params.config.mcp_servers.openship.url).toBe(expected);
    for (const id of [1, 2, 3, 4])
      expect(messages.find((m) => m.id === id).error.code).toBe(-32601);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
