import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  confirm: vi.fn(),
  note: vi.fn(),
  info: vi.fn(),
  wizard: vi.fn(),
  start: vi.fn(),
  composeStart: vi.fn(),
  wait: vi.fn(),
  open: vi.fn(),
  method: "compose" as string | null,
  installed: false,
  resuming: false,
  local: { apiUrl: "http://127.0.0.1:4100", dashboardUrl: "https://my-server.test" },
}));
vi.mock("@clack/prompts", () => ({
  confirm: h.confirm,
  isCancel: (v: unknown) => typeof v === "symbol",
  note: h.note,
  log: { info: h.info },
  outro: vi.fn(),
}));
vi.mock("@repo/onboarding", () => ({ waitForApi: h.wait }));
vi.mock("../../src/lib/local-connection", () => ({ localConnectionEndpoints: () => h.local }));
vi.mock("../../src/lib/compose", () => ({
  readInstallMethod: () => h.method,
  composeStart: h.composeStart,
}));
vi.mock("../../src/lib/service", () => ({ serviceStatus: () => ({ installed: h.installed }) }));
vi.mock("../../src/lib/ports", () => ({ storedDashboardPort: () => 3100 }));
vi.mock("../../src/commands/wizard", () => ({
  isSetupInProgress: () => h.resuming,
  runWizard: h.wizard,
}));
vi.mock("../../src/commands/up", () => ({ startService: h.start }));
vi.mock("open", () => ({ default: h.open }));

let tty: PropertyDescriptor | undefined;
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  h.method = "compose";
  h.installed = false;
  h.resuming = false;
  h.local = { apiUrl: "http://127.0.0.1:4100", dashboardUrl: "https://my-server.test" };
  h.wait.mockResolvedValue(true);
  h.confirm.mockResolvedValue(true);
  h.composeStart.mockReturnValue(true);
  vi.stubEnv("SSH_CONNECTION", "");
  vi.stubEnv("OPENSHIP_API_URL", "https://api.openship.io");
  vi.stubEnv("OPENSHIP_TOKEN", "must-not-be-used");
});
afterEach(() => {
  if (tty) Object.defineProperty(process.stdin, "isTTY", tty);
  else Reflect.deleteProperty(process.stdin, "isTTY");
  vi.unstubAllEnvs();
});
async function launch(args: string[]) {
  const { launchCommand } = await import("../../src/commands/launch");
  return launchCommand.parseAsync(args, { from: "user" });
}

describe("deploy button local launch", () => {
  it("reuses the installation and opens the existing wizard, ignoring ambient Cloud credentials", async () => {
    await launch(["--repo", "https://github.com/owner/repo", "--branch", "release/v2"]);
    expect(h.wizard).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
    expect(h.composeStart).not.toHaveBeenCalled();
    expect(h.wait.mock.calls.every(([options]) => options.apiUrl === "http://127.0.0.1:4100")).toBe(
      true,
    );
    const url = new URL(h.open.mock.calls[0][0]);
    expect(url.origin).toBe("https://my-server.test");
    expect(Buffer.from(url.pathname.split("/").pop()!, "base64url").toString()).toBe("owner/repo");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      branch: "release/v2",
      destination: "server",
    });
  });
  it("finishes interactive setup before resolving the new instance URL", async () => {
    h.method = null;
    h.wizard.mockImplementation(async () => {
      h.local.dashboardUrl = "https://new-server.test";
    });
    await launch(["--app", "n8n"]);
    expect(h.wizard).toHaveBeenCalledOnce();
    expect(h.open).toHaveBeenCalledExactlyOnceWith(
      "https://new-server.test/apps/new/n8n?destination=server",
    );
  });
  it("does not install when setup is declined", async () => {
    h.method = null;
    h.confirm.mockResolvedValue(false);
    await expect(launch(["--app", "n8n"])).rejects.toMatchObject({ code: 0 });
    expect(h.wizard).not.toHaveBeenCalled();
    expect(h.wait).not.toHaveBeenCalled();
    expect(h.open).not.toHaveBeenCalled();
  });
  it("starts an existing stopped Compose installation only after confirmation", async () => {
    h.wait.mockResolvedValueOnce(false);
    await launch(["--app", "n8n"]);
    expect(h.composeStart).toHaveBeenCalledOnce();
    expect(h.wizard).not.toHaveBeenCalled();
    expect(h.confirm.mock.calls[0][0].message).toContain("Start the existing");
  });
  it("refuses a broken existing installation without launching an unready dashboard", async () => {
    h.wait.mockResolvedValue(false);
    h.composeStart.mockReturnValue(false);
    await expect(launch(["--app", "n8n"])).rejects.toThrow("Could not start");
    expect(h.open).not.toHaveBeenCalled();
    expect(h.wizard).not.toHaveBeenCalled();
  });
  it("prints a private dashboard tunnel for SSH users without opening a server-side browser", async () => {
    vi.stubEnv("SSH_CONNECTION", "test-ssh");
    h.local.dashboardUrl = "http://localhost:3100";
    await launch(["--app", "n8n"]);
    expect(h.open).not.toHaveBeenCalled();
    expect(h.note.mock.calls.some(([value]) => value.includes("ssh -L 3100:127.0.0.1:3100"))).toBe(
      true,
    );
  });
  it("rejects invalid sources before any installation or network activity", async () => {
    await expect(launch(["--repo", "https://token@github.com/a/b"])).rejects.toThrow(
      "without credentials",
    );
    expect(h.wizard).not.toHaveBeenCalled();
    expect(h.wait).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
  });
  it("never guesses confirmation answers without a terminal", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    await expect(launch(["--app", "n8n"])).rejects.toThrow("interactive terminal");
    expect(h.wizard).not.toHaveBeenCalled();
    expect(h.wait).not.toHaveBeenCalled();
  });
});
