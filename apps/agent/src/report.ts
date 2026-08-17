import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AGENT_OPS } from "./protocol";
import { buildMutex } from "./mutex";
import agentPkg from "../package.json";

const execFileAsync = promisify(execFile);

export const AGENT_VERSION: string = agentPkg.version;
export const AGENT_CAPABILITIES = [...AGENT_OPS];

export type AgentReport = {
  version: string;
  capabilities: string[];
  disk: { totalBytes: number | null; freeBytes: number | null };
  containers?: Array<{ id: string; name: string; state: string; status: string }>;
  buildBusy: boolean;
};

async function run(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 15_000, maxBuffer: 1024 * 1024 });
    return stdout;
  } catch {
    return null;
  }
}

async function readDisk(): Promise<AgentReport["disk"]> {
  const out = await run("sh", [
    "-c",
    'root="$(docker info --format "{{.DockerRootDir}}" 2>/dev/null)"; ' +
      '[ -d "$root" ] || root=/var/lib/docker; [ -d "$root" ] || root=/; ' +
      "df -Pk \"$root\" 2>/dev/null | awk 'NR==2{print $2,$4}'",
  ]);
  if (!out) return { totalBytes: null, freeBytes: null };
  const [totalKb, freeKb] = out.trim().split(/\s+/).map(Number);
  const toBytes = (kb: number) => (Number.isFinite(kb) && kb > 0 ? kb * 1024 : null);
  return { totalBytes: toBytes(totalKb), freeBytes: toBytes(freeKb) };
}

async function readContainers(): Promise<AgentReport["containers"]> {
  const out = await run("docker", ["ps", "-a", "--format", "{{.ID}}\t{{.Names}}\t{{.State}}\t{{.Status}}"]);
  if (out == null) return undefined;
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, name, state, ...status] = line.split("\t");
      return { id: id ?? "", name: name ?? "", state: state ?? "", status: status.join("\t") };
    });
}

export async function collectReport(): Promise<AgentReport> {
  const [disk, containers] = await Promise.all([readDisk(), readContainers()]);
  return {
    version: AGENT_VERSION,
    capabilities: AGENT_CAPABILITIES,
    disk,
    containers,
    buildBusy: buildMutex.locked,
  };
}
