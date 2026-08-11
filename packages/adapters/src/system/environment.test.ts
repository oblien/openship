import { describe, it, expect, vi } from "vitest";
import { resolveEnvironment } from "./environment";
import type { CommandExecutor } from "../types";

/**
 * Fake executor that answers detection probes by substring match. A miss
 * returns "" (falsy) — matching how `command -v <missing>` reads to execSafe.
 */
function envFake(responses: Record<string, string>): CommandExecutor {
  const exec = vi.fn(async (command: string) => {
    for (const [key, val] of Object.entries(responses)) {
      if (command.includes(key)) return val;
    }
    return "";
  });
  return { exec } as unknown as CommandExecutor;
}

const BASE = {
  "uname -s": "Linux",
  "uname -m": "x86_64",
  "os-release": "ID=ubuntu",
  "command -v apt-get": "/usr/bin/apt-get",
  "command -v systemctl": "/usr/bin/systemctl",
};

describe("resolveEnvironment privilege detection", () => {
  it("reports isRoot when id -u is 0 and skips the sudo probe", async () => {
    const executor = envFake({ ...BASE, "id -u": "0" });
    const profile = await resolveEnvironment(executor);
    expect(profile.isRoot).toBe(true);
    expect(profile.canSudo).toBe(false);
    // sudo probe never runs for root
    expect(vi.mocked(executor.exec)).not.toHaveBeenCalledWith(
      expect.stringContaining("sudo -n true"),
      expect.anything(),
    );
  });

  it("reports canSudo for a non-root user with passwordless sudo", async () => {
    const executor = envFake({ ...BASE, "id -u": "1000", "sudo -n true": "yes" });
    const profile = await resolveEnvironment(executor);
    expect(profile.isRoot).toBe(false);
    expect(profile.canSudo).toBe(true);
  });

  it("reports neither for a non-root user without sudo", async () => {
    const executor = envFake({ ...BASE, "id -u": "1000", "sudo -n true": "no" });
    const profile = await resolveEnvironment(executor);
    expect(profile.isRoot).toBe(false);
    expect(profile.canSudo).toBe(false);
  });

  it("still detects os / package manager alongside privilege", async () => {
    const executor = envFake({ ...BASE, "id -u": "0" });
    const profile = await resolveEnvironment(executor);
    expect(profile.os).toBe("linux");
    expect(profile.packageManager).toBe("apt");
    expect(profile.serviceManager).toBe("systemd");
    expect(profile.distro).toBe("ubuntu");
  });
});
