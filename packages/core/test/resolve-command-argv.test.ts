import { describe, it, expect } from "vitest";
import { resolveCommandArgv } from "../src/shell-split";

/**
 * #332 follow-through. The parser produced argv, but the WRITERS didn't: every
 * path that takes a text `command` (service form, PATCH, sync endpoint, the deploy
 * request's own service list) left `commandArgv` alone, so a compose-imported row
 * kept running its old argv while the UI showed the new string, and a hand-created
 * row fell back to the `sh -c` wrap that breaks entrypoint+CMD images.
 */
describe("resolveCommandArgv", () => {
  it("derives argv from a first-write command (no sh -c)", () => {
    expect(resolveCommandArgv({ incomingCommand: "server start" })).toEqual([
      "server",
      "start",
    ]);
  });

  it("re-derives when the command is EDITED — the stale argv must not survive", () => {
    expect(
      resolveCommandArgv({
        incomingCommand: "server start --verbose",
        storedCommand: "server start",
        storedArgv: ["server", "start"],
      }),
    ).toEqual(["server", "start", "--verbose"]);
  });

  it("keeps the stored argv when the echoed-back command is UNCHANGED", () => {
    // The service form posts every field it owns on any save, so a restart-policy
    // edit re-sends the command verbatim. Re-splitting the display join here would
    // corrupt a list command (see next case).
    expect(
      resolveCommandArgv({
        incomingCommand: "sh -c a && b",
        storedCommand: "sh -c a && b",
        storedArgv: ["sh", "-c", "a && b"],
      }),
    ).toEqual(["sh", "-c", "a && b"]);
  });

  it("shows why that matters: the stored string is a LOSSY join", () => {
    // What re-deriving from the display join would have produced.
    expect(resolveCommandArgv({ incomingCommand: "sh -c a && b" })).toEqual([
      "sh",
      "-c",
      "a",
      "&&",
      "b",
    ]);
  });

  it("treats whitespace-only differences as unchanged", () => {
    expect(
      resolveCommandArgv({
        incomingCommand: "  server start  ",
        storedCommand: "server start",
        storedArgv: ["server", "start"],
      }),
    ).toEqual(["server", "start"]);
  });

  it("lets an explicit argv win over the string, including []", () => {
    expect(
      resolveCommandArgv({
        incomingArgv: ["sh", "-c", "a && b"],
        incomingCommand: "ignored",
        storedArgv: ["old"],
      }),
    ).toEqual(["sh", "-c", "a && b"]);
    // `[]` is meaningful: it clears the image CMD.
    expect(resolveCommandArgv({ incomingArgv: [] })).toEqual([]);
    // An explicit null clears the override.
    expect(resolveCommandArgv({ incomingArgv: null, storedArgv: ["old"] })).toBeNull();
  });

  it("returns undefined when the command isn't mentioned — a PATCH of another field", () => {
    expect(
      resolveCommandArgv({ storedCommand: "server start", storedArgv: ["server", "start"] }),
    ).toBeUndefined();
  });

  it("clears argv when the command is cleared", () => {
    for (const cleared of ["", "   ", null]) {
      expect(
        resolveCommandArgv({
          incomingCommand: cleared,
          storedCommand: "server start",
          storedArgv: ["server", "start"],
        }),
      ).toBeNull();
    }
  });

  it("derives for a legacy row that has a command but no argv", () => {
    expect(
      resolveCommandArgv({
        incomingCommand: "server start",
        storedCommand: "server start",
        storedArgv: null,
      }),
    ).toEqual(["server", "start"]);
  });
});
