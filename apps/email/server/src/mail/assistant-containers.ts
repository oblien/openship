import Docker from "dockerode";
import { Mindwire, provisionDocker, type DockerodeLike } from "mindwire";
import { env } from "../env";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const clients = new Map<string, Mindwire>();
const label = "io.openship.mail.assistant";
const port = 8790;
const runtimeDirectory = fileURLToPath(new URL("./runtime", import.meta.url));
const runtimeImage = `openship-mail-assistant:${createHash("sha256")
  .update(readFileSync(`${runtimeDirectory}/Dockerfile`))
  .digest("hex")
  .slice(0, 16)}`;
const builds = new Map<string, Promise<void>>();
const reservations = new Map<string, Set<string>>();

async function ensureRuntimeImage(engine: Docker, socket: string) {
  try {
    await engine.getImage(runtimeImage).inspect();
    return;
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode !== 404) throw error;
  }
  let build = builds.get(socket);
  if (!build) {
    build = (async () => {
      const stream = await engine.buildImage(
        { context: runtimeDirectory, src: ["Dockerfile"] },
        { t: runtimeImage, rm: true },
      );
      await new Promise<void>((resolve, reject) =>
        engine.modem.followProgress(stream, (error, output) => {
          const failure = output?.find((line: { error?: string }) => line.error);
          if (error || failure)
            reject(error ?? new Error("Could not prepare the mail runtime image."));
          else resolve();
        }),
      );
    })().finally(() => builds.delete(socket));
    builds.set(socket, build);
  }
  await build;
}

/** Called only after mailbox authentication. No browser-supplied Docker options or host paths. */
export function managedAssistant(owner: string): Mindwire {
  if (!/^[a-f0-9]{64}$/.test(owner) || !env.MAIL_MINDWIRE_DOCKER_SOCKET)
    throw new Error("Mail assistant runtime is unavailable.");
  if (
    env.MAIL_MINDWIRE_DOCKER_NETWORK &&
    /^(host|none|container:.*)$/.test(env.MAIL_MINDWIRE_DOCKER_NETWORK)
  )
    throw new Error("Mail assistants require a private Docker network.");
  const key = `${env.MAIL_MINDWIRE_DOCKER_SOCKET}:${owner}`;
  const cached = clients.get(key);
  if (cached) return cached;
  const engine = new Docker({ socketPath: env.MAIL_MINDWIRE_DOCKER_SOCKET });
  const name = `openship-mail-ai-${owner}`;
  const client = new Mindwire({
    agent: "codex",
    requestTimeoutMs: 30_000,
    target: {
      name: "mail-container",
      async connect() {
        const pending = reservations.get(env.MAIL_MINDWIRE_DOCKER_SOCKET!) ?? new Set<string>();
        reservations.set(env.MAIL_MINDWIRE_DOCKER_SOCKET!, pending);
        try {
          let existing = await engine
            .getContainer(name)
            .inspect()
            .catch((error) => {
              if (error.statusCode !== 404) throw error;
              return null;
            });
          if (existing && existing.Config.Labels?.[label] !== owner)
            throw new Error("Assistant container ownership mismatch.");
          // Bound resource use even when a mailbox starts setup repeatedly.
          if (!existing) {
            pending.add(owner);
            const containers = await engine.listContainers({
              all: true,
              filters: { label: [label] },
            });
            if (containers.length + pending.size > 32)
              throw new Error("Mail assistant capacity reached.");
            await ensureRuntimeImage(engine, env.MAIL_MINDWIRE_DOCKER_SOCKET!);
          }
          const handle = await provisionDocker(engine as unknown as DockerodeLike, {
            ...(existing ? { container: name } : {}),
            image: runtimeImage,
            pull: "never",
            agent: "codex",
            agentCwd: "/root",
            port,
            stopOnExit: false,
            createOptions: {
              name,
              Labels: { [label]: owner },
              HostConfig: {
                CapDrop: ["ALL"],
                SecurityOpt: ["no-new-privileges:true"],
                Memory: 512 * 1024 * 1024,
                MemorySwap: 512 * 1024 * 1024,
                NanoCpus: 1_000_000_000,
                PidsLimit: 128,
                ...(env.MAIL_MINDWIRE_DOCKER_NETWORK
                  ? { NetworkMode: env.MAIL_MINDWIRE_DOCKER_NETWORK }
                  : {}),
                PortBindings: { [`${port}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: "0" }] },
              },
            },
          });
          // When webmail itself is containerized, use its private network, never a public port.
          if (env.MAIL_MINDWIRE_DOCKER_NETWORK) {
            existing = await engine.getContainer(name).inspect();
            const address =
              existing.NetworkSettings.Networks[env.MAIL_MINDWIRE_DOCKER_NETWORK]?.IPAddress;
            if (!address) throw new Error("Mail runtime network is unavailable.");
            handle.baseUrl = `http://${address}:${port}`;
          }
          return handle;
        } catch (error) {
          clients.delete(key);
          throw error;
        } finally {
          pending.delete(owner);
        }
      },
    },
    fetch: async (input, init) => {
      try {
        return await fetch(input, { ...init, redirect: "error" });
      } catch (error) {
        clients.delete(key);
        throw error;
      }
    },
  });
  clients.set(key, client);
  return client;
}
