import { describe, expect, it, vi } from "vitest";
import { BareRuntime } from "./bare";
import { NohupSupervisor } from "./supervisor/nohup";
import { SystemdSupervisor } from "./supervisor/systemd";
import { probeOutput } from "../system/environment.fixtures";
import type { BuildConfig, CommandExecutor, DeployConfig } from "../types";
import type { ProcessSupervisor } from "./supervisor/types";

vi.mock("../toolchain", () => ({
  checkToolchainForStack: async () => ({ ready: true }),
  installTools: vi.fn(),
}));
// SSH journaling has its own transport tests; execute the commit against this
// permission-aware host so build and supervisor filesystem failures stay visible.
vi.mock("../system/remote-journal", () => ({
  execReliable: (executor: CommandExecutor, _id: string, command: string) => executor.exec(command),
}));

const ROOT = "/opt/openship";

/** Existing root-owned installation, accessed as a non-root deployment login. */
function host({ sudo = true, writable = false } = {}) {
  const owned = new Set(writable ? [ROOT] : []);
  const files = new Map<string, string>();
  const commands: string[] = [];
  const allowed = (path: string) =>
    [...owned].some((base) => path === base || path.startsWith(`${base}/`));
  const requireWrite = (path: string) => {
    if ((path === ROOT || path.startsWith(`${ROOT}/`)) && !allowed(path)) {
      throw new Error(`Permission denied: ${path}`);
    }
  };
  const executor: CommandExecutor = {
    async exec(command) {
      commands.push(command);
      if (command.includes("opsh_begin"))
        return probeOutput({ uid: "1000", user: "deploy", sudo: sudo ? "y" : "n" });
      if (command === "id -un") return "deploy";
      if (command.startsWith("sudo -n ")) {
        if (!sudo) throw new Error("sudo: a password is required");
        const path = command.replaceAll("'\\''", "'").match(/p='([^']+)'/)?.[1];
        if (path) owned.add(path);
        return "";
      }
      if (command.startsWith("mkdir -p ")) {
        requireWrite(command.match(/'([^']+)'/)![1]!);
      }
      if (command.startsWith("find ")) return "1";
      if (command.startsWith("command -v setsid")) return "n";
      if (command.includes(" & echo $!;")) return "42";
      return "";
    },
    async streamExec() {
      return { code: 0, output: "" };
    },
    async writeFile(path, content) {
      requireWrite(path);
      files.set(path, content);
    },
    async readFile(path) {
      return files.get(path) ?? "";
    },
    async exists(path) {
      return files.has(path);
    },
    async mkdir(path) {
      requireWrite(path);
    },
    async rm(path) {
      for (const file of files.keys()) {
        if (file === path || file.startsWith(`${path}/`)) {
          requireWrite(file);
          files.delete(file);
        }
      }
    },
    async transferIn(_source, target) {
      await executor.writeFile(`${target}/index.html`, "built locally");
    },
    async dispose() {},
  };
  return { executor, owned, files, commands };
}

function buildConfig(buildStrategy: "server" | "local" = "server"): BuildConfig {
  return {
    projectId: "project",
    sessionId: `permissions-${buildStrategy}`,
    buildStrategy,
    sourceStaged: true,
    stack: "static",
    packageManager: "npm",
    installCommand: "",
    buildCommand: "",
    envVars: {},
  } as BuildConfig;
}

function persistentDeploy(): DeployConfig {
  return {
    projectId: "project",
    deploymentId: "next",
    buildSessionId: "build",
    environment: "production",
    port: 3000,
    startCommand: "true",
    envVars: {},
    volumes: ["uploads:/app/uploads"],
    resources: { cpuCores: 0, memoryMb: 0, diskMb: 0 },
  };
}

describe("direct runtime deployment directory permissions (#1359)", () => {
  it("provisions project persistence before handing the release to its supervisor", async () => {
    const target = host();
    target.owned.add(`${ROOT}/project`);
    const activate = vi.fn();
    const runtime = new BareRuntime({
      executor: target.executor,
      supervisorFactory: async () => ({ deploy: activate }) as unknown as ProcessSupervisor,
    });
    await expect(runtime.deploy(persistentDeploy())).resolves.toMatchObject({ status: "running" });
    expect(activate).toHaveBeenCalledOnce();
    expect(target.owned.has(`${ROOT}/shared/project`)).toBe(true);
    expect(target.owned.has(ROOT)).toBe(false);
  });

  it("refuses activation when the login cannot provision persistent storage", async () => {
    const target = host({ sudo: false });
    target.owned.add(`${ROOT}/project`);
    const source = `${ROOT}/project/uploads`;
    target.files.set(source, "release seed");
    const supervisor = vi.fn(async () => ({ deploy: vi.fn() }) as unknown as ProcessSupervisor);
    const runtime = new BareRuntime({ executor: target.executor, supervisorFactory: supervisor });
    await expect(runtime.deploy(persistentDeploy())).rejects.toThrow(
      /Could not persist uploads.*passwordless sudo/s,
    );
    expect(supervisor).not.toHaveBeenCalled();
    expect(target.files.get(source)).toBe("release seed");
  });

  it("preserves existing shared data and refuses activation when its link fails", async () => {
    const target = host({ writable: true });
    const shared = `${ROOT}/shared/project/uploads`;
    target.files.set(shared, "customer data");
    const exec = target.executor.exec.bind(target.executor);
    target.executor.exec = async (command) => {
      if (command.startsWith("ln -sfn ")) throw new Error("Read-only file system");
      return exec(command);
    };
    const supervisor = vi.fn(async () => ({ deploy: vi.fn() }) as unknown as ProcessSupervisor);
    const runtime = new BareRuntime({ executor: target.executor, supervisorFactory: supervisor });
    await expect(runtime.deploy(persistentDeploy())).rejects.toThrow(
      /Could not persist uploads.*Read-only file system/,
    );
    expect(supervisor).not.toHaveBeenCalled();
    expect(target.files.get(shared)).toBe("customer data");
    expect(target.commands.some((command) => command.startsWith("sudo -n "))).toBe(false);
  });

  it.each(["server", "local"] as const)(
    "builds with %s strategy under a root-owned installation",
    async (strategy) => {
      const target = host();
      const config = buildConfig(strategy);
      const dir = `${ROOT}/.builds/${config.sessionId}`;
      // A previous root-run attempt must be removable before re-staging source.
      target.files.set(`${dir}/old.txt`, "old build");
      const runtime = new BareRuntime({
        executor: target.executor,
        prepareSource: async (_config, directory) => {
          await target.executor.writeFile(`${directory}/index.html`, "built on target");
          return true;
        },
      });
      const result = await runtime.build(config);
      expect(result.status).toBe("deploying");
      expect(result.imageRef).toBe(dir);
      expect(target.files.get(`${dir}/index.html`)).toBe(
        strategy === "server" ? "built on target" : "built locally",
      );
      expect(target.files.has(`${dir}/old.txt`)).toBe(false);
      expect([...target.owned]).toEqual([`${ROOT}/.builds`]);
    },
  );

  it("refuses before changing source when the login cannot provision the staging directory", async () => {
    const target = host({ sudo: false });
    const config = buildConfig();
    const previous = `${ROOT}/.builds/${config.sessionId}/old.txt`;
    target.files.set(previous, "keep me");
    const source = vi.fn(async () => true);
    await expect(
      new BareRuntime({ executor: target.executor, prepareSource: source }).build(config),
    ).rejects.toThrow(/passwordless sudo.*Run these once/s);
    expect(target.files.get(previous)).toBe("keep me");
    expect(source).not.toHaveBeenCalled();
  });

  it("keeps an already writable installation unelevated", async () => {
    const target = host({ sudo: false, writable: true });
    const result = await new BareRuntime({ executor: target.executor }).build(buildConfig());
    expect(result.status).toBe("deploying");
    expect(
      target.commands.some(
        (command) => command.startsWith("sudo -n ") || command.includes("opsh_begin"),
      ),
    ).toBe(false);
  });

  it("prepares scratch storage for a release command using a retained release", async () => {
    const target = host();
    await expect(
      new BareRuntime({ executor: target.executor }).runReleaseCommand(
        {
          projectId: "project",
          deploymentId: "next",
          buildSessionId: "build",
          imageRef: `${ROOT}/releases/live`,
          environment: "production",
          port: 3000,
          envVars: {},
          resources: { cpuCores: 0, memoryMb: 0, diskMb: 0 },
        },
        "true",
        () => {},
      ),
    ).resolves.toBeUndefined();
    expect([...target.owned]).toEqual([`${ROOT}/.builds`]);
  });

  it.each(["systemd", "nohup"])(
    "provisions %s bookkeeping before activating the app",
    async (kind) => {
      const target = host();
      const supervisor =
        kind === "systemd"
          ? new SystemdSupervisor(target.executor, ROOT)
          : new NohupSupervisor(target.executor, ROOT);
      if (kind === "systemd") vi.spyOn(supervisor, "isRunning").mockResolvedValue(true);
      await supervisor.deploy({
        projectId: "project",
        deploymentId: "next",
        workDir: `${ROOT}/releases/next`,
        startCommand: "true",
        port: 3000,
        env: {},
      });
      expect(target.files.get(`${ROOT}/.artifacts/next.path`)).toBe(`${ROOT}/releases/next`);
      if (kind === "nohup") expect(target.files.get(`${ROOT}/.pids/next.pid`)).toBe("42");
      expect(target.owned.has(ROOT)).toBe(false);
    },
  );

  it.each(["systemd", "nohup"])(
    "does not activate %s when bookkeeping cannot be provisioned",
    async (kind) => {
      const target = host({ sudo: false });
      const supervisor =
        kind === "systemd"
          ? new SystemdSupervisor(target.executor, ROOT)
          : new NohupSupervisor(target.executor, ROOT);
      await expect(
        supervisor.deploy({
          projectId: "project",
          deploymentId: "next",
          workDir: `${ROOT}/releases/next`,
          startCommand: "true",
          port: 3000,
          env: {},
        }),
      ).rejects.toThrow(/passwordless sudo/);
      expect(
        target.commands.some(
          (command) => command.includes("enable --now") || command.includes("nohup sh"),
        ),
      ).toBe(false);
      expect(target.files.size).toBe(0);
    },
  );
});
