import "./_setup-env";
import { describe, expect, test } from "vitest";
import type { CommandExecutor } from "@repo/adapters";
import { checkMailHealth } from "../../../src/modules/mail/mail-health.service";

function mockExecutor(
  handlers: Record<string, string | ((cmd: string) => string)>,
): CommandExecutor {
  return {
    exec: async (cmd: string) => {
      for (const [pattern, result] of Object.entries(handlers)) {
        if (cmd.includes(pattern)) {
          return typeof result === "function" ? result(cmd) : result;
        }
      }
      return "";
    },
  } as unknown as CommandExecutor;
}

describe("checkMailHealth spamassassin probe", () => {
  test("reports active when SpamAssassin runs inside amavis (no standalone unit)", async () => {
    const exec = mockExecutor({
      "systemctl show spamd": "LoadState=not-found\n",
      "command -v spamassassin": "active\n",
    });

    const results = await checkMailHealth(exec);
    const spamassassin = results.find((c) => c.key === "spamassassin");

    expect(spamassassin).toMatchObject({
      status: "active",
      subState: "integrated",
    });
  });

  test("keeps standalone active status when spamd.service is running", async () => {
    const exec = mockExecutor({
      "systemctl show spamd":
        "LoadState=loaded\nActiveState=active\nSubState=running\nActiveEnterTimestamp=Mon 2026-01-01 00:00:00 UTC\n",
    });

    const results = await checkMailHealth(exec);
    const spamassassin = results.find((c) => c.key === "spamassassin");

    expect(spamassassin).toMatchObject({
      status: "active",
      subState: "running",
    });
  });

  test("reports missing when neither standalone unit nor amavis-integrated SA exists", async () => {
    const exec = mockExecutor({
      "systemctl show spamd": "LoadState=not-found\n",
      "command -v spamassassin": "inactive\n",
    });

    const results = await checkMailHealth(exec);
    const spamassassin = results.find((c) => c.key === "spamassassin");

    expect(spamassassin).toMatchObject({ status: "missing" });
  });
});
