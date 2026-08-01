import { describe, expect, it } from "vitest";

import { resolveComposeCmd } from "../src/runtime/compose-cmd";

/**
 * #332: a compose `command` must become the container Cmd as argv (overriding
 * the image CMD, entrypoint intact) — NOT `["sh","-c",<string>]` appended after
 * an argv entrypoint.
 */
describe("resolveComposeCmd (#332)", () => {
  it("passes commandArgv through as-is (no sh -c) — the entrypoint+CMD fix", () => {
    expect(resolveComposeCmd({ commandArgv: ["serve", "--host", "0.0.0.0"], command: "serve --host 0.0.0.0" }))
      .toEqual(["serve", "--host", "0.0.0.0"]);
  });

  it("commandArgv wins even when a legacy command string is also present", () => {
    expect(resolveComposeCmd({ commandArgv: ["node", "x"], command: "ignored" })).toEqual(["node", "x"]);
  });

  it("empty commandArgv clears the image CMD (Cmd: [])", () => {
    expect(resolveComposeCmd({ commandArgv: [] })).toEqual([]);
  });

  it("legacy row (text command, no argv) keeps the sh -c wrap", () => {
    expect(resolveComposeCmd({ command: "node server.js && tail -f /dev/null" }))
      .toEqual(["sh", "-c", "node server.js && tail -f /dev/null"]);
  });

  it("no command at all → undefined (image CMD preserved)", () => {
    expect(resolveComposeCmd({})).toBeUndefined();
    expect(resolveComposeCmd({ commandArgv: null })).toBeUndefined();
    expect(resolveComposeCmd({ commandArgv: undefined, command: undefined })).toBeUndefined();
  });

  it("an explicit sh -c command survives as argv when parsed upstream", () => {
    // (parser turns `command: sh -c "a && b"` into argv; here it's already argv)
    expect(resolveComposeCmd({ commandArgv: ["sh", "-c", "a && b"] })).toEqual(["sh", "-c", "a && b"]);
  });
});
