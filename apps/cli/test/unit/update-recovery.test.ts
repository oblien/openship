import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

const h = vi.hoisted(() => ({
  source: vi.fn(), install: vi.fn(), method: vi.fn(), latest: vi.fn(),
  compose: vi.fn(), spawn: vi.fn(), payload: vi.fn(), shortSha: vi.fn(), remoteSha: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawnSync: h.spawn }));
vi.mock("../../src/lib/compose", () => ({ readInstallMethod: h.method, composeUpdate: h.compose }));
vi.mock("../../src/lib/github-releases", () => ({ resolveLatestTag: h.latest }));
vi.mock("../../src/lib/cli-install", () => ({ readCliInstall: h.install, writeCliInstall: vi.fn() }));
vi.mock("../../src/lib/cli-payload", () => ({ ensureCliPayload: h.payload }));
vi.mock("../../src/lib/node-runtime", () => ({ ensureNodeRuntime: vi.fn(async () => ({ source: "system" })), writeLauncher: vi.fn() }));
vi.mock("../../src/lib/source-install", () => ({ readSourceInstall: h.source, remoteSha: h.remoteSha, rebuildFromSource: vi.fn(async () => "new-sha") }));
vi.mock("../../src/lib/from-source", () => ({ shortSha: h.shortSha }));
vi.mock("../../src/lib/service", () => ({ restart: vi.fn(), selfInvocation: () => ({ runtime: "node", args: ["cli.js"] }) }));
vi.mock("../../src/lib/output", () => ({ isJsonMode: () => true, printJson: vi.fn(), err: vi.fn(), info: vi.fn(), ok: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
  vi.stubGlobal("__CLI_VERSION__", "0.9.11");
  vi.stubEnv("OPENSHIP_UPDATE_REEXEC", "");
  process.exitCode = 0;
  h.source.mockReturnValue(null);
  h.install.mockReturnValue(null);
  h.method.mockReturnValue("compose");
  h.latest.mockResolvedValue("v0.9.11");
  h.compose.mockResolvedValue({ applied: true });
  h.shortSha.mockReturnValue("current");
  h.remoteSha.mockReturnValue("current");
});
afterEach(() => { process.exitCode = 0; vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
async function update(args: string[] = []) {
  const { updateCommand } = await import("../../src/commands/update");
  await new Command().addCommand(updateCommand).parseAsync(["node", "openship", "update", ...args]);
}
function distribution(method: string) {
  if (method === "tarball") h.install.mockReturnValue({ method: "tarball", tag: "v0.9.11", launcher: "/opt/openship", runtime: "system" });
  if (method === "source") h.source.mockReturnValue({ dir: "/src", repo: "repo", ref: "main" });
}

describe.each(["tarball", "npm", "source"])("%s update recovery", method => {
  it("reconciles the Compose stack when its CLI is already current", async () => {
    distribution(method);
    await update();
    expect(h.compose).toHaveBeenCalledOnce();
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.payload).not.toHaveBeenCalled();
  });
  it("leaves --check read-only", async () => {
    distribution(method);
    await update(["--check"]);
    expect(h.compose).not.toHaveBeenCalled();
    expect(h.spawn).not.toHaveBeenCalled();
  });
  it("propagates an unsuccessful reconciliation to the exit status", async () => {
    distribution(method);
    h.compose.mockResolvedValue({ applied: false });
    await update();
    expect(process.exitCode).toBe(1);
  });
  it("does not start an uninstalled/bare Compose stack", async () => {
    distribution(method);
    h.method.mockReturnValue(null);
    await update();
    expect(h.compose).not.toHaveBeenCalled();
  });
});
describe.each(["tarball", "npm", "source"])("%s update child failure", method => {
  it("reports a signaled reconciliation child as failure", async () => {
    distribution(method);
    h.latest.mockResolvedValue("v0.9.12");
    h.remoteSha.mockReturnValue("new-sha");
    h.spawn.mockImplementation((_command, args) => args.includes("--apply-only")
      ? { status: null, signal: "SIGTERM" }
      : { status: 0 });
    await update(["--via", "npm"]);
    expect(h.spawn).toHaveBeenCalledWith("node", ["cli.js", "--json", "update", "--apply-only"], expect.any(Object));
    expect(process.exitCode).toBe(1);
    expect(h.compose).not.toHaveBeenCalled();
  });
});
