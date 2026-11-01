import { mkdir, chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Mindwire, local, type NativeAuthSource, type TargetHandle } from "mindwire";
import {
  assistantEnvironment,
  HARNESS,
  PROVIDERS,
  probeHarness,
  writeHarnessWrapper,
  type HarnessProbe,
} from "./harness-policy";
import type { AssistantProvider } from "@repo/contracts";
import type { AssistantConnectionRow } from "@repo/db";

/** Private daemon placement shared by assistant sessions and deterministic chat connectors. */
export type MindwireHostConnection = Pick<
  AssistantConnectionRow,
  "userId" | "organizationId" | "serverId" | "origin"
>;

export interface AssistantNativeClient {
  mindwire: Mindwire;
  probe(provider: AssistantProvider): Promise<HarnessProbe>;
  workspace(id: string): Promise<string>;
  healthy(): boolean;
  close(): Promise<void>;
}
export type AssistantClientFactory = (
  connection: AssistantConnectionRow,
) => Promise<AssistantNativeClient>;

/** Mindwire owns native auth and daemon startup; OpenShip supplies scope and private workspaces. */
export async function createAssistantClient(
  directory: string,
  userId: string,
  authSource: NativeAuthSource | "host" | "private" = "host",
  purpose: "assistant" | "chat-apps" = "assistant",
): Promise<AssistantNativeClient> {
  const system = process.platform,
    arch = process.arch;
  if ((system !== "darwin" && system !== "linux") || (arch !== "arm64" && arch !== "x64"))
    throw new Error("Scoped native agents currently require macOS or Linux on ARM64 or x64.");
  const root = join(directory, createHash("sha256").update(userId).digest("hex"));
  for (const name of [
    "",
    "home",
    "home/.codex",
    "home/.claude",
    "tmp",
    "cache",
    "bin",
    "work",
    "toolchains",
  ]) {
    const path = join(root, name);
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  }
  const searchPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  // macOS Unix sockets have a short path limit. Mindwire's local Git broker also starts at boot.
  const temporary = await mkdtemp("/tmp/openship-mw-");
  const env = {
    ...assistantEnvironment(root, [join(root, "bin"), searchPath].join(":")),
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
  };
  const target = local({
    cwd: join(root, "work"),
    statePath: join(root, "state.json"),
    environment: { ...env, AGENT_TYPE: HARNESS.codex.agent },
    authSource:
      authSource === "private"
        ? { home: join(root, "home"), environment: {}, reuse: "manual" }
        : authSource,
    shared: false,
    exactVersion: true,
  });
  // Older SDKs silently ignore environment/authSource/shared. Do not start a
  // daemon or inspect a native harness unless the SDK implements this contract.
  const profileSupported = target.profileVersion >= 1;
  const updateMessage =
    "Update the Mindwire SDK to connect local agents. Reinstall OpenShip dependencies and restart the app.";
  const probes = new Map<AssistantProvider, { result: HarnessProbe; checked: number }>();
  const probing = new Map<AssistantProvider, Promise<HarnessProbe>>();
  async function probe(provider: AssistantProvider) {
    if (!profileSupported)
      return { provider, version: "", available: false, issue: updateMessage, flags: [] };
    const cached = probes.get(provider);
    if (cached && Date.now() - cached.checked < 3000) return cached.result;
    let pending = probing.get(provider);
    if (!pending) {
      pending = (async () => {
        const result = await probeHarness(provider, searchPath, env);
        await writeHarnessWrapper(join(root, "bin"), result);
        probes.set(provider, { result, checked: Date.now() });
        return result;
      })().finally(() => probing.delete(provider));
      probing.set(provider, pending);
    }
    return pending;
  }
  try {
    if (purpose === "assistant") await Promise.all(PROVIDERS.map(probe));
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  let handle: TargetHandle | undefined;
  let stopped = false;
  let failed = false;
  const mindwire = new Mindwire({
    agent: "codex",
    requestTimeoutMs: 30000,
    target: {
      name: target.name,
      async connect(spec) {
        if (stopped) throw new Error("Assistant host is closed.");
        if (!profileSupported) throw new Error(updateMessage);
        try {
          handle = await target.connect(spec);
          return handle;
        } catch (error) {
          failed = true;
          throw error;
        }
      },
    },
  });
  async function close() {
    if (stopped) return;
    stopped = true;
    try {
      await mindwire.close();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  return {
    mindwire,
    probe,
    healthy: () => !stopped && !failed && (!handle || handle.isAlive?.() !== false),
    async workspace(id) {
      // Neither browser nor model can select a filesystem path.
      const path = join(root, "work", createHash("sha256").update(id).digest("hex"));
      await mkdir(path, { recursive: true, mode: 0o700 });
      return path;
    },
    close,
  };
}

export { ApiError } from "mindwire";
export type {
  AuthMethod,
  AuthState,
  Interaction,
  MessagePage,
  Message,
  QuestionAnswer,
  Run,
} from "mindwire";
