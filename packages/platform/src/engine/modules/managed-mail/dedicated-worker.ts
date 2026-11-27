import { AppError } from "@repo/core";
import { z } from "zod";

const config = z
  .object({
    origin: z.url().refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && url.origin === value;
    }),
    token: z.string().min(1),
    domain: z.hostname(),
    sshPublicKey: z.string().regex(/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]+)?$/),
    dnsProvider: z.enum(["cloudflare", "digitalocean"]),
    dnsToken: z.string().min(1),
    webmailIngressIPv4: z.ipv4().optional(),
    zoneId: z.string().min(1),
  })
  .strict();
export type DedicatedMailFleet = z.infer<typeof config>;

export function parseDedicatedMailFleet(value?: string) {
  if (!value) return null;
  try {
    return config.parse(JSON.parse(value));
  } catch {
    throw new AppError("Dedicated mail fleet configuration is invalid.", 503);
  }
}

const serverRecord = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string().nullable(),
  sshHost: z.string().nullable(),
  sshUser: z.string().nullable(),
  sshJumpHost: z.string().nullable(),
});

async function workerServers(fleet: DedicatedMailFleet, body?: object) {
  const result = await fetch(new URL("/api/system/servers", fleet.origin), {
    method: body ? "POST" : "GET",
    redirect: "error",
    signal: AbortSignal.timeout(45_000),
    headers: { authorization: "Bearer " + fleet.token, "content-type": "application/json" },
    body: body && JSON.stringify(body),
  });
  if (!result.ok)
    throw new AppError("Could not register the dedicated VM with the mail worker.", 502);
  return result.json() as Promise<unknown>;
}

export async function listDedicatedWorkerServers(fleet: DedicatedMailFleet) {
  return z.array(serverRecord).parse(await workerServers(fleet));
}

export async function registerDedicatedWorkerServer(
  fleet: DedicatedMailFleet,
  server: { name: string; sshHost: string; sshUser: string; sshJumpHost: string },
) {
  const result = await workerServers(fleet, { ...server, sshPort: 22, sshAuthMethod: "agent" });
  return serverRecord.parse(result);
}
