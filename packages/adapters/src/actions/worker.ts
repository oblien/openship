import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ACTIONS_ENGINE_VERSION,
  ACTIONS_PROTOCOL_VERSION,
  AppError,
  shellQuote as q,
  type ActionCapabilities,
  type ActionJobResult,
  type ActionWorkerEvent,
  type ActionWorkerRequest,
} from "@repo/core";
import type { CommandExecutor } from "../types";
import { dockerArchitecture, probeDockerExecutionPlatforms } from "../runtime/docker-platforms";

export interface ActionWorkerSnapshot {
  state: "idle" | "running" | "finished" | "interrupted";
  events: ActionWorkerEvent[];
  hasMore: boolean;
  result?: ActionJobResult;
}

/** Probe the selected endpoint; there is no controller-host execution fallback. */
export async function probeActionCapabilities(
  executor: CommandExecutor,
): Promise<ActionCapabilities> {
  const output = await executor.exec(
    `uname -s
uname -m
command -v git >/dev/null 2>&1 && printf 'git=yes\\n' || true
command -v node >/dev/null 2>&1 && printf 'node=yes\\n' || true
docker info --format 'docker={{.OSType}}\ndockerArch={{.Architecture}}' 2>/dev/null || true
if [ -f /etc/os-release ]; then sed -n -e 's/^ID=/distribution=/p' -e 's/^VERSION_ID=/version=/p' /etc/os-release; fi
if command -v sw_vers >/dev/null 2>&1; then printf 'version='; sw_vers -productVersion; fi`,
    { timeout: 15_000 },
  );
  const [system, arch, ...entries] = output.split(/\r?\n/).map((line) => line.trim());
  const os = system === "Linux" ? "linux" : system === "Darwin" ? "macos" : null;
  const architecture =
    arch === "x86_64" || arch === "amd64"
      ? "x64"
      : arch === "arm64" || arch === "aarch64"
        ? "arm64"
        : null;
  if (!os || !architecture)
    throw new AppError(
      "Actions supports Linux and macOS runners on x64 or ARM64",
      409,
      "ACTIONS_RUNNER_UNSUPPORTED",
    );
  const flags = Object.fromEntries(
    entries
      .filter((line) => line.includes("="))
      .map((line) => {
        const i = line.indexOf("=");
        return [line.slice(0, i), line.slice(i + 1).replace(/^"|"$/g, "")];
      }),
  );
  const docker = flags.docker === "linux";
  const dockerArch = dockerArchitecture(flags.dockerArch) ?? architecture;
  return {
    os,
    architecture,
    docker,
    ...(docker
      ? {
          dockerArchitecture: dockerArch,
          dockerPlatforms: await probeDockerExecutionPlatforms(executor, dockerArch),
        }
      : {}),
    git: flags.git === "yes",
    node: flags.node === "yes",
    distribution: flags.distribution ?? null,
    version: flags.version ?? null,
  };
}

type Manifest = {
  protocol: number;
  engine: string;
  files: Record<string, { name: string; sha256: string }>;
};

export class ActionsWorker {
  constructor(
    private readonly executor: CommandExecutor,
    private readonly assetsDirectory: string,
  ) {}

  /** The binary comes from the installed release and is verified on both ends. */
  async prepare(capabilities: ActionCapabilities): Promise<{ binary: string; root: string }> {
    const target = `${capabilities.os === "macos" ? "darwin" : "linux"}/${capabilities.architecture === "x64" ? "amd64" : "arm64"}`;
    let manifest: Manifest;
    try {
      manifest = JSON.parse(await readFile(join(this.assetsDirectory, "manifest.json"), "utf8"));
    } catch (cause) {
      const error = new AppError(
        "The Actions runner is missing from this Openship installation. Install a release containing the Actions runner assets.",
        503,
        "ACTIONS_RUNNER_ASSET_MISSING",
      );
      error.cause = cause;
      throw error;
    }
    const file = manifest.files[target];
    if (
      manifest.protocol !== ACTIONS_PROTOCOL_VERSION ||
      manifest.engine !== `act/${ACTIONS_ENGINE_VERSION}` ||
      !file ||
      !/^openship-actions-(linux|darwin)-(amd64|arm64)$/.test(file.name) ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw new AppError(
        "The installed Actions runner manifest is invalid",
        503,
        "ACTIONS_RUNNER_ASSET_INVALID",
      );
    const local = await readFile(join(this.assetsDirectory, file.name));
    if (createHash("sha256").update(local).digest("hex") !== file.sha256)
      throw new AppError(
        "Actions runner checksum verification failed",
        503,
        "ACTIONS_RUNNER_ASSET_INVALID",
      );
    const home = (await this.executor.exec('printf "%s" "$HOME"')).trim();
    if (!home.startsWith("/") || home.includes("\n") || home === "/")
      throw new Error("The runner requires a valid home directory");
    const root = `${home}/.local/share/openship/actions`;
    const directory = `${root}/bin/${file.sha256}`;
    const binary = `${directory}/${file.name}`;
    const hash = `if command -v sha256sum >/dev/null 2>&1; then sha256sum ${q(binary)}; else shasum -a 256 ${q(binary)}; fi`;
    if (
      (await this.executor.exists(binary)) &&
      (await this.executor.exec(hash)).split(/\s/)[0] === file.sha256
    )
      return { binary, root };
    const staging = `${root}/install-${randomUUID()}`;
    await this.executor.mkdir(staging);
    try {
      await this.executor.transferIn(this.assetsDirectory, staging, undefined, {
        includes: [file.name],
        excludes: [],
      });
      const staged = `${staging}/${file.name}`;
      const stagedHash = await this.executor.exec(
        `if command -v sha256sum >/dev/null 2>&1; then sha256sum ${q(staged)}; else shasum -a 256 ${q(staged)}; fi`,
      );
      if (stagedHash.split(/\s/)[0] !== file.sha256)
        throw new Error("Transferred Actions runner failed checksum verification");
      await this.executor.exec(
        `chmod 700 ${q(staged)} && mkdir -p ${q(directory)} && mv ${q(staged)} ${q(binary)}`,
      );
      if (
        (await this.executor.exec(`${q(binary)} version`)).trim() !==
        `openship-actions/1 act/${ACTIONS_ENGINE_VERSION}`
      )
        throw new Error("Actions runner protocol mismatch");
    } finally {
      await this.executor.rm(staging);
    }
    return { binary, root };
  }

  async inspect(binary: string, directory: string, after = 0): Promise<ActionWorkerSnapshot> {
    if (!Number.isSafeInteger(after) || after < 0)
      throw new TypeError("Invalid worker event cursor");
    const text = await this.executor.exec(`${q(binary)} inspect ${q(directory)} ${after}`, {
      timeout: 20_000,
    });
    if (Buffer.byteLength(text) > 1024 * 1024)
      throw new Error("Actions worker response exceeded its limit");
    const value = JSON.parse(text) as ActionWorkerSnapshot;
    if (
      !value ||
      !["idle", "running", "finished", "interrupted"].includes(value.state) ||
      !Array.isArray(value.events) ||
      value.events.length > 200 ||
      typeof value.hasMore !== "boolean"
    )
      throw new Error("Actions worker returned an invalid response");
    for (const event of value.events) {
      if (
        event.version !== 1 ||
        !Number.isSafeInteger(event.sequence) ||
        event.sequence <= after ||
        !["started", "log", "result"].includes(event.type)
      )
        throw new Error("Actions worker event is invalid");
    }
    return value;
  }

  async start(binary: string, directory: string, request: ActionWorkerRequest): Promise<void> {
    const snapshot = await this.inspect(binary, directory);
    if (snapshot.state !== "idle") return;
    await this.executor.exec(`mkdir -p ${q(directory)} && chmod 700 ${q(directory)}`);
    // No secret is embedded in a command, argv, URL, or the controller's logs.
    const input = `${directory}/request.json`;
    const staged = `${directory}/request-${randomUUID()}.json`;
    await this.executor.writeFile(staged, JSON.stringify(request), { mode: 0o600 });
    // A retry must not truncate a request that an already-starting worker is reading.
    await this.executor.exec(
      `(ln ${q(staged)} ${q(input)} 2>/dev/null || test -f ${q(input)}) && rm ${q(staged)}`,
    );
    // The worker's file lock and persisted start record prevent re-execution
    // after an uncertain SSH/provider response. It owns timeout and cancellation.
    await this.executor.exec(
      `(nohup ${q(binary)} run ${q(input)} >${q(`${directory}/protocol-error.log`)} 2>&1 </dev/null &)`,
    );
  }

  async cancel(binary: string, directory: string): Promise<void> {
    if (await this.executor.exists(directory))
      await this.executor.exec(`${q(binary)} cancel ${q(directory)}`);
  }

  async clean(binary: string, directory: string): Promise<void> {
    // The worker holds its lock while reaping this attempt's tracked processes,
    // labelled containers and private volumes. Interrupted attempts are never
    // rerun, and an uncertain cleanup never releases their scheduler slot.
    if (!(await this.executor.exists(directory))) return;
    await this.executor.exec(`${q(binary)} clean ${q(directory)}`, { timeout: 90_000 });
    await this.executor.rm(directory);
  }
}
