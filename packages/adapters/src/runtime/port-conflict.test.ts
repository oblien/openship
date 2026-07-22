import { describe, expect, test } from "vitest";
import type { CommandExecutor } from "../types";
import { probeListeningPort } from "./port-conflict";

describe("probeListeningPort", () => {
  test("does not treat an outbound socket as a listener in the lsof fallback", async () => {
    const commands: string[] = [];
    const executor = {
      exec: async (command: string) => {
        commands.push(command);
        if (command.startsWith("ss ")) return "";
        if (command.includes("-sTCP:LISTEN")) return "";
        if (command.startsWith("lsof ")) return "4242";
        throw new Error(`unexpected command: ${command}`);
      },
    } as unknown as CommandExecutor;

    expect(await probeListeningPort(executor, 443)).toBeNull();
    expect(commands.some((command) => command.includes("-sTCP:LISTEN"))).toBe(true);
  });
});
