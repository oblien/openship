import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  choice: "cloud" as string | symbol,
  login: vi.fn(),
  promptUrl: vi.fn(),
  select: vi.fn(),
}));
vi.mock("@clack/prompts", () => ({
  intro: () => {},
  outro: () => {},
  log: { info: () => {}, message: () => {} },
  isCancel: (value: unknown) => typeof value === "symbol",
  select: h.select,
}));
vi.mock("../../src/lib/config", () => ({
  getActiveContext: () => "cloud",
  getContext: () => ({ apiUrl: "https://api.openship.io" }),
}));
vi.mock("../../src/commands/login", () => ({
  runLogin: h.login,
  promptSelfHostedUrl: h.promptUrl,
}));
import { runWelcome } from "../../src/commands/welcome";
import { CommandExit } from "../../src/lib/command-exit";

beforeEach(() => {
  vi.clearAllMocks();
  h.choice = "cloud";
  h.select.mockImplementation(async () => h.choice);
  h.promptUrl.mockResolvedValue("https://ship.example.com");
});

describe("first-run destination chooser", () => {
  it.each(["cloud", "remote"])("connects to %s without installing a service", async (choice) => {
    h.choice = choice;
    const install = vi.fn();
    const help = vi.fn();
    await runWelcome(install, help);
    expect(install).not.toHaveBeenCalled();
    expect(help).not.toHaveBeenCalled();
    expect(h.login).toHaveBeenCalledExactlyOnceWith(
      choice === "cloud"
        ? { cloud: true }
        : { apiUrl: "https://ship.example.com", context: "ship.example.com" },
    );
  });

  it("runs the existing installer only after the installation choice", async () => {
    h.choice = "install";
    const install = vi.fn();
    await runWelcome(install, vi.fn());
    expect(install).toHaveBeenCalledOnce();
    expect(h.login).not.toHaveBeenCalled();
  });

  it("leaves the machine and connections untouched on help or cancellation", async () => {
    const install = vi.fn();
    const help = vi.fn();
    h.choice = "help";
    await runWelcome(install, help);
    expect(help).toHaveBeenCalledOnce();
    h.choice = Symbol("cancel");
    await expect(runWelcome(install, help)).rejects.toBeInstanceOf(CommandExit);
    expect(install).not.toHaveBeenCalled();
    expect(h.login).not.toHaveBeenCalled();
  });
});
