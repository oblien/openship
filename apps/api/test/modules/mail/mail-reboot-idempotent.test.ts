import "./_setup-env";
import { describe, expect, test, vi } from "vitest";

import { stepReboot } from "../../../src/modules/mail/mail.service";

/**
 * Step 10 kills its own connection, so it never records success and Resume
 * replays it. On a box that already came back up that means a second, pointless
 * reboot — of the control plane and every app on it. The step has to recognize
 * the reboot it already caused.
 *
 * `btime` is the kernel's boot epoch; `iRedMail.tips` is the installer's last
 * write. Boot newer than tips ⇒ the post-install reboot already happened.
 */
function rebootExecutor({ btime, tips }: { btime: number; tips: number }) {
  const commands: string[] = [];
  const executor = {
    exec: async (cmd: string) => {
      commands.push(cmd);
      if (cmd.includes("btime")) return `${btime}\n`;
      if (cmd.includes("iRedMail.tips")) return `${tips}\n`;
      return "";
    },
  } as never;
  return { executor, commands };
}

const reconnect = () => Promise.reject(new Error("should not reconnect"));

describe("step 10 reboot", () => {
  test("skips when the box booted after the installer finished", async () => {
    const { executor, commands } = rebootExecutor({ btime: 1785256111, tips: 1785256090 });

    const result = await stepReboot(executor, "example.com", () => {}, reconnect);

    expect(result.success).toBe(true);
    expect(result.message).toContain("already rebooted");
    expect(commands.some((c) => c.includes("reboot"))).toBe(false);
  });

  test("reboots when the installer finished after the last boot", async () => {
    const { executor, commands } = rebootExecutor({ btime: 1785250000, tips: 1785256090 });
    vi.useFakeTimers();

    // Don't await: the real path sleeps 30s before reconnecting. Asserting the
    // reboot was issued is the point; the wait loop is not under test.
    void stepReboot(executor, "example.com", () => {}, reconnect);
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();

    expect(commands.some((c) => c.includes("reboot"))).toBe(true);
  });

  test("reboots when the probes can't be read (fails closed)", async () => {
    const { executor, commands } = rebootExecutor({ btime: 0, tips: 0 });
    vi.useFakeTimers();

    void stepReboot(executor, "example.com", () => {}, reconnect);
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();

    expect(commands.some((c) => c.includes("reboot"))).toBe(true);
  });
});
