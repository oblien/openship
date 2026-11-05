import { afterEach, describe, expect, it, vi } from "vitest";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LocalExecutor } from "./local-executor";
import { hasLocalCommand, sq } from "./local-shell";
import { createExecutor } from "./executor";
import { BareRuntime } from "../runtime/bare";
import { resolveDockerTransport } from "../runtime/docker-transport";
import { runLocalBuild } from "../runtime/local-build";
import { CloudWorkspaceExecutor } from "../runtime/cloud/workspace-executor";
import { NginxProvider } from "../infra/nginx";
import { canUseRemoteRsync } from "./remote-transfer";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function marker() {
  const dir = await mkdtemp(join(tmpdir(), "openship-host-boundary-"));
  dirs.push(dir);
  const path = join(dir, "executed");
  return { path, command: `printf unsafe > ${sq(path)}` };
}

describe("Cloud cannot execute on the API host", () => {
  it.each(["true", "1"])(
    "rejects every local command entrypoint with CLOUD_MODE=%s",
    async (mode) => {
      const executor = createExecutor();
      const direct = new LocalExecutor();
      const { path, command } = await marker();
      const onLog = vi.fn();
      vi.stubEnv("CLOUD_MODE", mode);
      for (const operation of [
        () => executor.exec(command),
        () => direct.exec(command),
        () => executor.streamExec(command, onLog),
        () => executor.streamExec(command, onLog, { signal: AbortSignal.abort() }),
        () => executor.transferIn!("/does-not-exist", path),
      ]) {
        await expect(operation()).rejects.toMatchObject({
          statusCode: 403,
          code: "LOCAL_HOST_ACCESS_DENIED",
        });
      }
      expect(onLog).not.toHaveBeenCalled();
      await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("refuses implicit bare runtimes and local Docker sockets, including pre-created transports", async () => {
    vi.stubEnv("CLOUD_MODE", "false");
    const transport = resolveDockerTransport({ transport: "socket" });
    vi.stubEnv("CLOUD_MODE", "true");
    expect(() => new BareRuntime()).toThrow(/scoped executor/);
    expect(() => resolveDockerTransport()).toThrow(/scoped executor/);
    expect(() => resolveDockerTransport({ transport: "socket" })).toThrow(/scoped executor/);
    await expect(transport.establish()).rejects.toMatchObject({ code: "LOCAL_HOST_ACCESS_DENIED" });
  });

  it("refuses local builds before source preparation or filesystem staging", async () => {
    vi.stubEnv("CLOUD_MODE", "true");
    const preflight = vi.fn();
    const transferOutput = vi.fn();
    await expect(
      runLocalBuild({
        config: { sessionId: "never-start" } as never,
        logger: {} as never,
        preflight,
        transferOutput,
      }),
    ).rejects.toMatchObject({ code: "LOCAL_HOST_ACCESS_DENIED" });
    expect(preflight).not.toHaveBeenCalled();
    expect(transferOutput).not.toHaveBeenCalled();
  });

  it("rejects the local routing-provider fallback before reading paths or invoking certbot", () => {
    vi.stubEnv("CLOUD_MODE", "true");
    expect(() => new NginxProvider({ paths: {} as never })).toThrow(/scoped executor/);
  });

  it("preserves the provider failure instead of retrying a command on the API host", async () => {
    vi.stubEnv("CLOUD_MODE", "true");
    const { path, command } = await marker();
    const executor = new CloudWorkspaceExecutor(async () => {
      throw new Error("provider unavailable");
    }, "owned-vm");
    await expect(executor.exec(command)).rejects.toThrow("provider unavailable");
    await expect(executor.rawExec(command)).rejects.toThrow("provider unavailable");
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    await executor.dispose();
  });

  it("preserves explicit remote bare and provider Docker transports in Cloud", () => {
    vi.stubEnv("CLOUD_MODE", "true");
    const remote = { exec: vi.fn(), streamExec: vi.fn() };
    const runtime = new BareRuntime({ executor: remote as never });
    expect(runtime.commandExecutor).toBe(remote);
    const cloud = resolveDockerTransport({
      transport: "cloud",
      executor: remote as never,
      cloudConnection: async () => {
        throw new Error("provider unavailable");
      },
    });
    expect(cloud.kind).toBe("cloud");
  });
});

describe("self-hosted and Desktop keep their explicit local transport", () => {
  it.each(["false", "0", ""])("executes local commands with CLOUD_MODE=%s", async (mode) => {
    vi.stubEnv("CLOUD_MODE", mode);
    const executor = new LocalExecutor();
    expect(await executor.exec("printf local-ok")).toBe("local-ok");
    const logs: string[] = [];
    expect(
      (await executor.streamExec("printf streamed-ok", (entry) => logs.push(entry.message))).code,
    ).toBe(0);
    expect(logs.join("")).toBe("streamed-ok");
  });
});

describe("safe local transport probes", () => {
  it.each(["false", "true", "1"])(
    "treats probe arguments as data with CLOUD_MODE=%s",
    async (mode) => {
      vi.stubEnv("CLOUD_MODE", mode);
      const { path, command } = await marker();
      expect(await hasLocalCommand(`sh; ${command}`)).toBe(false);
      await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await hasLocalCommand("sh")).toBe(true);
    },
  );

  it.each(["true", "1"])("preserves SSH transfer preflight with CLOUD_MODE=%s", async (mode) => {
    vi.stubEnv("CLOUD_MODE", mode);
    const { path, command } = await marker();
    const binDir = dirname(path);
    for (const name of ["rsync", "ssh", "sshpass"]) {
      await writeFile(join(binDir, name), `#!/bin/sh\n${command}\n`, { mode: 0o700 });
    }
    vi.stubEnv("PATH", `${binDir}:/usr/bin:/bin`);
    const hasRemoteCommand = vi.fn().mockResolvedValue(true);
    await expect(
      canUseRemoteRsync({
        config: { host: "fixture.invalid", username: "fixture", password: "fixture" },
        hasRemoteCommand,
      }),
    ).resolves.toEqual({ ok: true });
    expect(hasRemoteCommand).toHaveBeenCalledWith("rsync");
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
