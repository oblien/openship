import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { basename, dirname, posix } from "node:path";
import { Mindwire, ensureDaemonBinary, SDK_VERSION, type TargetHandle } from "mindwire";
import { sq, type CommandExecutor } from "@repo/adapters";
import type { AssistantConnectionRow } from "@repo/db";
import type { AssistantProvider } from "@repo/contracts";
import { AppError } from "@repo/core";
import { createProvisionLock } from "../../lib/provision-lock";
import { acquireServerExecution, withServerExecution } from "../../lib/server-execution";
import { readCloudWorkspaceConnection } from "../../lib/cloud-workspace-host";
import { tunnelForward } from "../../lib/ssh-tunnel";
import { revalidateAssistantTarget } from "./target-access";
import {
  assistantEnvironment,
  harnessWrapper,
  inspectHarness,
  HARNESS,
  type HarnessProbe,
} from "./harness-policy";
import { CODEX_GUARD } from "./codex-guard";
import type { AssistantNativeClient, MindwireHostConnection } from "./native-target";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const assistantProfileKey = (
  connection: Pick<AssistantConnectionRow, "userId" | "organizationId" | "serverId">,
) => hash(JSON.stringify([connection.organizationId, connection.userId, connection.serverId]));
const fail = (message: string) => new AppError(message, 503, "ASSISTANT_HOST_UNAVAILABLE");
const variables = (env: NodeJS.ProcessEnv) =>
  Object.entries(env)
    .filter((pair): pair is [string, string] => pair[1] !== undefined)
    .map(([key, value]) => sq(`${key}=${value}`))
    .join(" ");
type Installed = { port: number; token: string; version: string; policy: string };

async function writeAtomic(executor: CommandExecutor, path: string, value: string, mode: number) {
  const temporary = `${path}.${randomUUID()}`;
  await executor.writeFile(temporary, value, { mode });
  if (executor.rename) await executor.rename(temporary, path);
  else await executor.exec(`mv -f -- ${sq(temporary)} ${sq(path)}`);
}

/** Customer-host transport only. Provisioning uses the same owned execution boundary as deployments. */
export async function createRemoteAssistantClient(
  connection: MindwireHostConnection,
  purpose: "assistant" | "chat-apps" = "assistant",
): Promise<AssistantNativeClient> {
  const server = await revalidateAssistantTarget(connection, connection.serverId);
  if (!server) throw fail("Choose a server for this assistant.");
  const access = await acquireServerExecution(connection.organizationId, server.id);
  let closed = false;
  let failed = false;
  let handle: TargetHandle | undefined;
  const assertAccess = () => revalidateAssistantTarget(connection, server.id);
  try {
    const [system, home, searchPath] = await access.run(async (executor) =>
      Promise.all([
        executor.exec("uname -sm"),
        executor.exec('printf "%s" "$HOME"'),
        executor.exec('printf "%s" "$PATH"'),
      ]),
    );
    const [os, machine] = system.trim().split(/\s+/);
    if (!["Linux", "Darwin"].includes(os!) || !["x86_64", "aarch64", "arm64"].includes(machine!))
      throw fail("Remote assistants require Linux or macOS on ARM64 or x64.");
    if (!home.startsWith("/") || home.includes("\n"))
      throw fail("The server has no valid home directory.");
    const root = posix.join(
      home.trim(),
      ".openship",
      purpose === "assistant" ? "assistants" : "chat-apps",
      assistantProfileKey(connection),
    );
    const temporary = `/tmp/openship-mw-${purpose}-${assistantProfileKey(connection).slice(0, 20)}`;
    const mcpUrl = `${connection.origin}/api/mcp`;
    if (new URL(mcpUrl).protocol !== "https:")
      throw fail("Remote assistants require an HTTPS OpenShip API.");
    const env = {
      ...assistantEnvironment(
        root,
        `${root}/bin:${searchPath.trim() || "/usr/local/bin:/usr/bin:/bin"}`,
      ),
      OPENSHIP_ASSISTANT_MCP_URL: mcpUrl,
      TMPDIR: temporary,
      TMP: temporary,
      TEMP: temporary,
    };
    // These folders contain only this member's agent sign-in and chats. Never import server-admin auth.
    await access.run((executor) =>
      executor.exec(
        `umask 077; mkdir -p -- ${[root, "home", "home/.codex", "home/.claude", "bin", "tmp", "cache", "work", "toolchains"].map((p) => sq(p === root ? p : `${root}/${p}`)).join(" ")}; chmod 700 ${sq(root)}`,
      ),
    );
    await access.run((executor) =>
      executor.exec(
        `umask 077; mkdir -p -- ${sq(temporary)}; test ! -L ${sq(temporary)} && test -O ${sq(temporary)} && chmod 700 ${sq(temporary)}`,
      ),
    );
    const probes = new Map<AssistantProvider, { at: number; result: HarnessProbe }>();
    async function probe(provider: AssistantProvider) {
      await assertAccess();
      const cached = probes.get(provider);
      if (cached && Date.now() - cached.at < 3000) return cached.result;
      return createProvisionLock(
        `assistant:probe:${server!.id}:${assistantProfileKey(connection)}:${provider}`,
      ).run(async () => {
        const executor = access.executor;
        const find = async (binary: string) => {
          try {
            const value = (
              await executor.exec(`/bin/bash -lc ${sq(`type -P -- ${sq(binary)}`)}`, {
                timeout: 10000,
              })
            ).trim();
            return value.startsWith("/") &&
              !value.includes("\n") &&
              !value.startsWith(`${root}/bin/`)
              ? value
              : undefined;
          } catch {
            return undefined;
          }
        };
        const path = await find(HARNESS[provider].binary);
        const node = provider === "codex" ? await find("node") : undefined;
        const result = await inspectHarness(provider, path, async (args) => {
          const output = await access.run((ex) =>
            ex.exec(`env -i ${variables(env)} ${sq(path!)} ${args.map(sq).join(" ")}`, {
              timeout: 10000,
            }),
          );
          if (Buffer.byteLength(output) > 256000)
            throw fail("Agent inspection returned too much data.");
          return output;
        });
        if (result.available && provider === "codex" && !node) {
          result.available = false;
          result.issue =
            "Install a supported Node.js runtime on this server to use the scoped Codex connection.";
        }
        await writeAtomic(executor, `${root}/bin/codex-guard.mjs`, CODEX_GUARD, 0o600);
        await writeAtomic(
          executor,
          `${root}/bin/${HARNESS[provider].binary}`,
          harnessWrapper(`${root}/bin`, result, node),
          0o700,
        );
        probes.set(provider, { at: Date.now(), result });
        return result;
      });
    }

    async function transport(record: Installed): Promise<TargetHandle> {
      if (server!.workspaceId) {
        const owned = await readCloudWorkspaceConnection(
          connection.organizationId,
          server!.workspaceId,
        );
        let runtime = await owned.client.workspace(owned.binding.workspaceId!).runtime();
        const baseUrl = "http://openship-assistant.invalid";
        return {
          id: `assistant:${server!.id}`,
          baseUrl,
          async fetch(input, init = {}) {
            // Callers reauthorize before every operation. Retained transport must still
            // allow the worker to cancel its own run after that authorization is removed.
            const url = new URL(input);
            if (url.origin !== baseUrl) throw fail("Invalid assistant transport destination.");
            const headers = new Headers(init.headers);
            // The provider proxy reserves Authorization for its own rotating gateway credential.
            headers.delete("Authorization");
            headers.set("X-Mindwire-Token", record.token);
            const send = () =>
              runtime.proxy(record.port).fetch(`${url.pathname}${url.search}`, {
                ...init,
                signal: init.signal ?? undefined,
                headers,
              });
            let result = await send();
            if (result.status === 401) {
              runtime = await owned.client
                .workspace(owned.binding.workspaceId!)
                .runtime({ force: true });
              result = await send();
            }
            return result;
          },
          async stop() {}, // Closing a control-plane client must never stop a customer's VM.
        };
      }
      const tunnel = await tunnelForward(server!.id, record.port, { preferredPort: 0 });
      return {
        id: `assistant:${server!.id}`,
        baseUrl: `http://127.0.0.1:${tunnel.localPort}`,
        token: record.token,
        stop: () => tunnel.close(),
      };
    }

    async function provision(): Promise<TargetHandle> {
      return createProvisionLock(
        `mindwire:${purpose}:host:${server!.id}:${assistantProfileKey(connection)}`,
      ).run(async () => {
        await assertAccess();
        const policy = hash(JSON.stringify([CODEX_GUARD, harnessWrapper.toString(), mcpUrl]));
        // Download and verify before reserving an idle daemon for replacement.
        const binary = await ensureDaemonBinary({
          platform: os === "Linux" ? "linux" : "darwin",
          arch: machine === "x86_64" ? "x64" : "arm64",
          exactVersion: true,
          fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(60_000) }),
        });
        let record: Installed | undefined;
        try {
          const value = JSON.parse(await access.executor.readFile(`${root}/service.json`));
          if (
            Number.isInteger(value.port) &&
            value.port > 1024 &&
            value.port < 65536 &&
            /^[a-f0-9]{64}$/.test(value.token)
          )
            record = value;
        } catch {
          /* First installation or an interrupted atomic write. */
        }
        if (record) {
          const previous = await transport(record);
          const existing = new Mindwire({
            target: { name: "existing-assistant", connect: async () => previous },
            requestTimeoutMs: 5000,
          });
          let retained = false;
          try {
            const health = await existing.health();
            if (health.version === SDK_VERSION && record.policy === policy) {
              retained = true;
              return previous;
            }
            // Normal Mindwire idle update lease: never interrupt another member's running work.
            const lease = await existing.service.acquireUpdate();
            if (!Number.isSafeInteger(lease.pid) || lease.pid <= 1)
              throw fail("Invalid assistant update lease.");
            await access.run((ex) => ex.exec(`kill -TERM ${lease.pid}`));
          } catch (error) {
            // A reachable busy daemon must not be replaced. Only transport failure permits a fresh start.
            if (error && typeof error === "object" && "status" in error) throw error;
            const output = await access.executor.exec(
              `curl -s --max-time 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:${record.port}/healthz || true`,
            );
            if (output.trim() !== "000")
              throw fail(
                "The assistant service could not be safely updated. Finish its active work and retry.",
              );
          } finally {
            if (!retained) await previous.stop();
          }
        }
        await withServerExecution(
          connection.organizationId,
          server!.id,
          async (executor) => {
            const staged = `${root}/release-${randomUUID()}`;
            await executor.exec(`umask 077; mkdir -p -- ${sq(staged)}`);
            try {
              await executor.transferIn(dirname(binary), staged, undefined, {
                excludes: [],
                includes: [basename(binary)],
              });
              await executor.exec(
                `chmod 700 ${sq(`${staged}/${basename(binary)}`)}; mv -f -- ${sq(`${staged}/${basename(binary)}`)} ${sq(`${root}/mindwired`)}`,
              );
            } finally {
              await executor.rm(staged);
            }
          },
          { mutation: true, scope: "assistant" },
        );
        const next: Installed = {
          port: randomInt(20000, 60000),
          token: randomBytes(32).toString("hex"),
          version: SDK_VERSION,
          policy,
        };
        const daemonEnv = {
          ...env,
          ADDR: `127.0.0.1:${next.port}`,
          AGENT_CWD: `${root}/work`,
          STATE_PATH: `${root}/state.json`,
          DAEMON_TOKEN: next.token,
          AGENT_TYPE: "codex",
          MINDWIRE_AUTH_SOURCE: JSON.stringify({
            home: `${root}/home`,
            environment: {},
            reuse: "manual",
          }),
        };
        // No API/Stripe/database environment is forwarded, and no host-native auth is read.
        await writeAtomic(
          access.executor,
          `${root}/launch`,
          `#!/bin/sh\ncd ${sq(`${root}/work`)} || exit 1\nexec env -i ${variables(daemonEnv)} ${sq(`${root}/mindwired`)}\n`,
          0o700,
        );
        // Keep the private endpoint recoverable if startup or its response is delayed.
        // A retry can authenticate and reuse this daemon instead of losing its identity.
        await writeAtomic(access.executor, `${root}/service.json`, JSON.stringify(next), 0o600);
        await access.run((executor) =>
          executor.exec(
            `umask 077; nohup ${sq(`${root}/launch`)} > ${sq(`${root}/service.log`)} 2>&1 < /dev/null &`,
          ),
        );
        const connected = await transport(next);
        const check = new Mindwire({
          target: { name: "assistant-check", connect: async () => connected },
          requestTimeoutMs: 1000,
        });
        let ready = false;
        const startupDeadline = Date.now() + 30_000;
        while (Date.now() < startupDeadline) {
          try {
            ready = (await check.health()).version === SDK_VERSION;
          } catch {
            /* Startup only. */
          }
          if (ready) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (!ready) {
          await connected.stop();
          throw fail(
            "Mindwire could not start on the selected server. Check that host's available memory and loopback networking.",
          );
        }
        return connected;
      });
    }
    const mindwire = new Mindwire({
      agent: "codex",
      requestTimeoutMs: 30000,
      target: {
        name: `openship-server:${server.id}`,
        async connect() {
          if (closed) throw fail("The assistant host connection is closed.");
          handle = await provision();
          const request = handle.fetch ?? globalThis.fetch;
          handle.fetch = async (input, init) => {
            try {
              return await request(input, init);
            } catch (error) {
              // A deliberate stream cancellation is not a failed host. Network failures
              // invalidate this client; the next explicit request can reconnect without
              // replaying an operation whose outcome is unknown.
              if (!init?.signal?.aborted) failed = true;
              throw error;
            }
          };
          return handle;
        },
      },
    });
    await mindwire.health();
    return {
      mindwire,
      probe,
      healthy: () => !closed && !failed,
      async workspace(id) {
        await assertAccess();
        const directory = `${root}/work/${hash(id)}`;
        await access.run((executor) => executor.exec(`umask 077; mkdir -p -- ${sq(directory)}`));
        return directory;
      },
      async close() {
        if (closed) return;
        closed = true;
        try {
          await mindwire.close();
        } finally {
          await handle?.stop();
          await access.release();
        }
      },
    };
  } catch (error) {
    await handle?.stop();
    await access.release();
    throw error;
  }
}
