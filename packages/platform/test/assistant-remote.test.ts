import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rename, rm, cp, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { connect } from "node:net";
import { Server, type Connection } from "ssh2";
import { SshExecutor } from "../../adapters/src/system/ssh-executor";
import type { CommandExecutor } from "@repo/adapters";
import type { AssistantConnectionRow } from "@repo/db";

const host = vi.hoisted(() => ({
  executor: undefined as CommandExecutor | undefined,
  ssh: undefined as SshExecutor | undefined,
  server: { id: "isolated-assistant-server", workspaceId: null as string | null },
  proxyCalls: 0,
  forceRefreshes: 0,
  startupDelay: false,
}));
vi.mock("../src/engine/modules/assistant/target-access", () => ({
  revalidateAssistantTarget: async () => host.server,
}));
vi.mock("../src/engine/lib/server-execution", () => ({
  acquireServerExecution: async () => ({
    executor: host.executor,
    server: host.server,
    run: (fn: any) => fn(host.executor),
    release: async () => {},
  }),
  withServerExecution: async (_org: string, _server: string, fn: any) => fn(host.executor),
}));
vi.mock("../src/engine/lib/ssh-manager", () => ({ sshManager: { acquire: async () => host.ssh } }));
vi.mock("../src/engine/lib/provision-lock", () => ({
  createProvisionLock: () => ({ run: (fn: any) => fn() }),
}));
vi.mock("../src/engine/lib/cloud-workspace-host", () => ({
  readCloudWorkspaceConnection: async (organization: string, workspace: string) => {
    expect(organization).toBe("assistant-native-test");
    expect(workspace).toBe("owned-workspace");
    return {
      binding: { workspaceId: "owned-provider-vm" },
      client: {
        workspace: (id: string) => {
          expect(id).toBe("owned-provider-vm");
          return {
            runtime: async (options?: { force?: boolean }) => {
              if (options?.force) host.forceRefreshes++;
              return {
                proxy: (port: number) => ({
                  fetch: async (path: string, init: RequestInit) => {
                    const headers = new Headers(init.headers);
                    expect(headers.has("Authorization")).toBe(false);
                    expect(headers.get("X-Mindwire-Token")).toMatch(/^[a-f0-9]{64}$/);
                    if (++host.proxyCalls === 1) return new Response(null, { status: 401 });
                    return fetch(`http://127.0.0.1:${port}${path}`, init);
                  },
                }),
              };
            },
          };
        },
      },
    };
  },
}));
import {
  createRemoteAssistantClient,
  assistantProfileKey,
} from "../src/engine/modules/assistant/remote-target";
import type { AssistantNativeClient } from "../src/engine/modules/assistant/native-target";

// Explicit opt-in: downloads the SDK-matched daemon if absent. Native account login/logout is never called.
describe.skipIf(process.env.OPENSHIP_ASSISTANT_E2E !== "1")(
  "Assistant daemon on an isolated SSH host",
  () => {
    let directory: string, server: Server;
    const clients: AssistantNativeClient[] = [];
    const sshConnections = new Set<Connection>();
    const rows: AssistantConnectionRow[] = [];
    const connection = (user: string): AssistantConnectionRow => ({
      userId: user,
      organizationId: "assistant-native-test",
      clientId: `fixture-${user}`,
      origin: "https://assistant.example.test",
      serverId: host.server.id,
      createdAt: new Date(),
    });
    beforeAll(async () => {
      directory = await mkdtemp("/tmp/opsh-assistant-ssh-");
      const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({ type: "pkcs1", format: "pem" })
        .toString();
      server = new Server({ hostKeys: [key] }, (client) => {
        sshConnections.add(client);
        client.on("close", () => sshConnections.delete(client));
        client.on("error", () => {});
        client.on("authentication", (ctx) =>
          ctx.method === "password" && ctx.password === "fixture-only"
            ? ctx.accept()
            : ctx.reject(),
        );
        client.on("ready", () => {
          client.on("session", (accept) => {
            const session = accept();
            session.on("exec", (acceptExec, _reject, info) => {
              const channel = acceptExec();
              const child = spawn("/bin/bash", ["-c", info.command], {
                cwd: directory,
                env: { PATH: process.env.PATH, HOME: directory, LANG: "en_US.UTF-8" },
                stdio: ["pipe", "pipe", "pipe"],
              });
              channel.pipe(child.stdin);
              child.stdout.pipe(channel, { end: false });
              child.stderr.pipe(channel.stderr, { end: false });
              child.on("close", (code) => {
                channel.exit(code ?? 1);
                channel.end();
              });
              channel.on("close", () => {
                if (child.exitCode === null) child.kill();
              });
            });
          });
          client.on("tcpip", (accept, reject, info) => {
            if (info.destIP !== "127.0.0.1") {
              reject();
              return;
            }
            const socket = connect(info.destPort, "127.0.0.1");
            socket.once("connect", () => {
              const channel = accept();
              socket.pipe(channel).pipe(socket);
              channel.on("error", () => socket.destroy());
              channel.on("close", () => socket.destroy());
              socket.on("error", () => channel.destroy());
            });
            socket.once("error", () => {
              try {
                reject();
              } catch {}
            });
          });
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      host.ssh = new SshExecutor({
        host: "127.0.0.1",
        port: (server.address() as { port: number }).port,
        username: "fixture",
        password: "fixture-only",
      });
      const check = (path: string) => {
        if (!path.startsWith(`${directory}/`))
          throw new Error("Fixture file operation escaped its temporary directory");
      };
      // File IO stays on the disposable target's filesystem; command and HTTP channels traverse real SSH.
      host.executor = {
        exec: (cmd, opts) =>
          host.ssh!.exec(
            host.startupDelay
              ? cmd.replace(
                  "nohup ",
                  "nohup /bin/sh -c 'sleep 5; exec \"$@\"' openship-test-delay ",
                )
              : cmd,
            opts,
          ),
        async writeFile(path, value, options) {
          check(path);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, value, { mode: options?.mode });
        },
        async readFile(path) {
          check(path);
          return readFile(path, "utf8");
        },
        async rename(a, b) {
          check(a);
          check(b);
          await rename(a, b);
        },
        async rm(path) {
          check(path);
          await rm(path, { recursive: true, force: true });
        },
        async transferIn(from, to, _log, options) {
          check(to);
          for (const file of options?.includes ?? []) await cp(join(from, file), join(to, file));
        },
      } as CommandExecutor;
    }, 30000);

    afterAll(async () => {
      // Kill only these isolated test daemons using their authenticated idle-update leases.
      for (const client of clients) {
        try {
          const lease = await client.mindwire.service.acquireUpdate();
          process.kill(lease.pid, "SIGTERM");
        } catch {}
        await client.close();
      }
      await host.ssh?.dispose();
      for (const connection of sshConnections) connection.end();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      for (const row of rows)
        for (const purpose of ["assistant", "chat-apps"])
          await rm(`/tmp/openship-mw-${purpose}-${assistantProfileKey(row).slice(0, 20)}`, {
            recursive: true,
            force: true,
          });
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    it("installs privately, serves over SSH, reuses its daemon, and isolates members", async () => {
      const first = connection("alice"),
        second = connection("bob");
      rows.push(first, second);
      const a = await createRemoteAssistantClient(first);
      clients.push(a);
      const health = await a.mindwire.health();
      expect(health.version).toBeTruthy();
      const firstRoot = join(directory, ".openship/assistants", assistantProfileKey(first));
      const recordA = JSON.parse(await readFile(join(firstRoot, "service.json"), "utf8"));
      expect((await stat(join(firstRoot, "service.json"))).mode & 0o777).toBe(0o600);
      expect((await stat(firstRoot)).mode & 0o777).toBe(0o700);
      const launch = await readFile(join(firstRoot, "launch"), "utf8");
      expect(launch).toContain("127.0.0.1:");
      expect(launch).toContain("env -i");
      expect(launch).not.toContain("DATABASE_URL");
      expect(launch).not.toContain("BETTER_AUTH_SECRET");
      expect(await a.workspace("private-chat")).toContain(firstRoot);
      // Closing a controller releases its SSH tunnel without stopping the customer's daemon.
      await a.close();
      const again = await createRemoteAssistantClient(first);
      clients.push(again);
      expect((await again.mindwire.health()).version).toBe(health.version);
      const reused = JSON.parse(await readFile(join(firstRoot, "service.json"), "utf8"));
      expect(reused).toEqual(recordA);
      // A host process restart must discard the dead transport and preserve the profile.
      const workspace = await again.workspace("survives-restart");
      await writeFile(join(workspace, "fixture.txt"), "retained");
      const lease = await again.mindwire.service.acquireUpdate();
      process.kill(lease.pid, "SIGTERM");
      await vi.waitFor(async () => {
        await expect(again.mindwire.health()).rejects.toThrow();
      });
      expect(again.healthy()).toBe(false);
      await again.close();
      const recovered = await createRemoteAssistantClient(first);
      clients.push(recovered);
      expect((await recovered.mindwire.health()).version).toBe(health.version);
      expect(
        await readFile(join(await recovered.workspace("survives-restart"), "fixture.txt"), "utf8"),
      ).toBe("retained");
      const b = await createRemoteAssistantClient(second);
      clients.push(b);
      expect((await b.mindwire.health()).version).toBe(health.version);
      const secondRoot = join(directory, ".openship/assistants", assistantProfileKey(second));
      const recordB = JSON.parse(await readFile(join(secondRoot, "service.json"), "utf8"));
      expect(recordB.token).not.toBe(recordA.token);
      expect(secondRoot).not.toBe(firstRoot);
      expect(
        (
          await fetch(`http://127.0.0.1:${recordB.port}/healthz`, {
            headers: { Authorization: `Bearer ${recordA.token}` },
          })
        ).status,
      ).toBe(401);
    }, 120000);

    it("isolates chat connectors from the same member's assistant profile", async () => {
      const row = connection("chat-member");
      rows.push(row);
      const assistant = await createRemoteAssistantClient(row);
      clients.push(assistant);
      const chat = await createRemoteAssistantClient(row, "chat-apps");
      clients.push(chat);
      expect((await chat.mindwire.health()).version).toBeTruthy();
      const key = assistantProfileKey(row);
      const chatRoot = join(directory, ".openship/chat-apps", key);
      const assistantRoot = join(directory, ".openship/assistants", key);
      const chatRecord = JSON.parse(await readFile(join(chatRoot, "service.json"), "utf8"));
      const assistantRecord = JSON.parse(
        await readFile(join(assistantRoot, "service.json"), "utf8"),
      );
      expect(chatRecord.port).not.toBe(assistantRecord.port);
      expect(chatRecord.token).not.toBe(assistantRecord.token);
      expect((await stat(chatRoot)).mode & 0o777).toBe(0o700);
      const launch = await readFile(join(chatRoot, "launch"), "utf8");
      expect(launch).toContain("env -i");
      expect(launch).not.toContain(assistantRoot);
      expect(await chat.workspace("chat-commands")).toContain(chatRoot);
    }, 120000);

    it("waits for a slow host startup and keeps the same private endpoint on reconnect", async () => {
      const row = connection("slow-start");
      rows.push(row);
      host.startupDelay = true;
      try {
        const chat = await createRemoteAssistantClient(row, "chat-apps");
        clients.push(chat);
        expect((await chat.mindwire.health()).version).toBeTruthy();
        const path = join(
          directory,
          ".openship/chat-apps",
          assistantProfileKey(row),
          "service.json",
        );
        const first = JSON.parse(await readFile(path, "utf8"));
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        await chat.close();
        const reconnected = await createRemoteAssistantClient(row, "chat-apps");
        clients.push(reconnected);
        expect((await reconnected.mindwire.health()).version).toBeTruthy();
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual(first);
      } finally {
        host.startupDelay = false;
      }
    }, 120000);

    it("uses the managed VM loopback proxy without exposing or replacing its gateway credential", async () => {
      host.server.workspaceId = "owned-workspace";
      const row = connection("carol");
      rows.push(row);
      const client = await createRemoteAssistantClient(row);
      clients.push(client);
      expect((await client.mindwire.health()).version).toBeTruthy();
      expect(host.proxyCalls).toBeGreaterThan(1);
      expect(host.forceRefreshes).toBe(1);
      await expect(client.mindwire.service.updateStatus()).resolves.toMatchObject({ idle: true });
    }, 120000);
  },
);
