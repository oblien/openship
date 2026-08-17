import { readFileSync } from "node:fs";
import { AGENT_DEFAULT_LISTEN, AGENT_DEFAULT_PORT } from "./protocol";

export const DEFAULT_CONFIG_PATH = "/etc/openship/agent.json";
export const DEFAULT_JOURNAL_PATH = "/var/lib/openship/agent/journal.jsonl";

export type AgentConfig = {
  controlPlaneUrl: string;
  serverId: string;
  keyId: string;
  sharedSecret: string;
  listenHost: string;
  listenPort: number;
  heartbeatSeconds: number;
  journalPath: string;
};

type RawConfig = Partial<{
  controlPlaneUrl: string;
  serverId: string;
  keyId: string;
  sharedSecret: string;
  listenHost: string;
  listenPort: number;
  heartbeatSeconds: number;
  journalPath: string;
}>;

function parseJsonObject(raw: string, source: string): RawConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Agent config in ${source} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Agent config in ${source} must be a JSON object`);
  }
  return parsed as RawConfig;
}

function loadRaw(): RawConfig {
  const envPath = process.env.OPENSHIP_AGENT_CONFIG;
  if (envPath) {
    const trimmed = envPath.trim();
    if (trimmed.startsWith("{")) return parseJsonObject(trimmed, "OPENSHIP_AGENT_CONFIG");
    return parseJsonObject(readFileSync(trimmed, "utf8"), trimmed);
  }
  return parseJsonObject(readFileSync(DEFAULT_CONFIG_PATH, "utf8"), DEFAULT_CONFIG_PATH);
}

function required(raw: RawConfig, key: keyof RawConfig): string {
  const value = raw[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Agent config missing ${String(key)}`);
  }
  return value.trim();
}

export function loadAgentConfig(): AgentConfig {
  const raw = loadRaw();
  const listen = process.env.OPENSHIP_AGENT_LISTEN?.trim() || raw.listenHost || AGENT_DEFAULT_LISTEN;
  const portRaw = process.env.OPENSHIP_AGENT_PORT ?? raw.listenPort ?? AGENT_DEFAULT_PORT;
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid agent listen port: ${portRaw}`);
  }
  const heartbeat = Number(process.env.OPENSHIP_AGENT_HEARTBEAT ?? raw.heartbeatSeconds ?? 30);
  return {
    controlPlaneUrl: required(raw, "controlPlaneUrl").replace(/\/+$/, ""),
    serverId: required(raw, "serverId"),
    keyId: required(raw, "keyId"),
    sharedSecret: required(raw, "sharedSecret"),
    listenHost: listen,
    listenPort: port,
    heartbeatSeconds: Number.isFinite(heartbeat) && heartbeat > 0 ? heartbeat : 30,
    journalPath: process.env.OPENSHIP_AGENT_JOURNAL?.trim() || raw.journalPath || DEFAULT_JOURNAL_PATH,
  };
}
