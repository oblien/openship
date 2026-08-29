import { describe, expect, it } from "vitest";

import { resolveComposeCmd, resolveComposeEntrypoint } from "../src/runtime/compose-cmd";

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

/**
 * #575: the other half of container shape. The whole point of this resolver is that
 * `undefined` and `[]` are DIFFERENT answers — keep the image's ENTRYPOINT versus
 * clear it — because collapsing them is what kept an image's wrapper running and
 * handed it the operator's command as arguments.
 */
describe("resolveComposeEntrypoint (#575)", () => {
  it("passes an override through as argv", () => {
    expect(resolveComposeEntrypoint({ entrypoint: ["/custom-init.sh", "--flag"] })).toEqual([
      "/custom-init.sh",
      "--flag",
    ]);
  });

  // THE case the issue is about: `entrypoint: []` + a command is how you run a binary
  // directly in an image whose ENTRYPOINT is a wrapper.
  it("preserves an EMPTY array — that is the clear, not an absence", () => {
    const out = resolveComposeEntrypoint({ entrypoint: [] });
    expect(out).toEqual([]);
    expect(out).not.toBeUndefined();
  });

  it("is undefined when no entrypoint was recorded, so the image default stands", () => {
    // A row parsed before the field existed, and one whose blob is absent entirely.
    expect(resolveComposeEntrypoint({})).toBeUndefined();
    expect(resolveComposeEntrypoint(undefined)).toBeUndefined();
    // `null` should never be STORED — mergeAdvanced deletes a key set to null — but
    // `advanced` is untyped JSONB, so a hand-edited row can hold one. Normalize it
    // rather than forwarding `Entrypoint: null` to Docker.
    expect(resolveComposeEntrypoint({ entrypoint: null })).toBeUndefined();
  });
});
