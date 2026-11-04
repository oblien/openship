import { describe, expect, it } from "bun:test";
import { CHAT_COMMANDS, PROJECT_COMMANDS, parseChatCommand, chatNativeCommands } from "../src";

describe("shared command syntax", () => {
  it("maps each CLI project command and native alias to the same operation", () => {
    for (const command of Object.values(PROJECT_COMMANDS)) {
      const argument = command.argument ? " project_123" : "";
      expect(parseChatCommand(`/openship project ${command.name}${argument}`)).toEqual(
        parseChatCommand(`${command.chat}${argument}`),
      );
    }
  });
  it("keeps multi-line assistant prompts intact and rejects shell/extra arguments", () => {
    expect(parseChatCommand("ask Check my app\nKeep this line.\n```\nhi\n```")).toEqual({
      verb: "ask",
      arg: "Check my app\nKeep this line.\n```\nhi\n```",
    });
    for (const input of [
      "project restart x;whoami",
      "restart $(id)",
      "project get ../../etc",
      "project restart p extra",
      "project delete p",
      "restart p --yes",
      "ask",
    ])
      expect(parseChatCommand(input).verb).toBe("help");
    expect(parseChatCommand("restart")).toEqual({ verb: "restart" }); // chat project picker
  });
  it("only advertises allowed, parseable commands without duplicates", () => {
    expect(new Set(CHAT_COMMANDS.map((c) => c.verb)).size).toBe(CHAT_COMMANDS.length);
    for (const purpose of ["assistant", "commands", "both"] as const) {
      for (const command of chatNativeCommands(purpose)) {
        expect(parseChatCommand(`${command.name}${command.argument ? " test" : ""}`).verb).toBe(
          command.name,
        );
      }
    }
    expect(chatNativeCommands("commands").some((c) => c.name === "ask")).toBe(false);
    expect(chatNativeCommands("assistant").some((c) => c.name === "restart")).toBe(false);
  });
});
