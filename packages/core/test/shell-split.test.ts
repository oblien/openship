import { describe, expect, it } from "vitest";
import { commandToArgv, shellSplitWords } from "../src/shell-split";

describe("shellSplitWords", () => {
  it("splits on unquoted whitespace", () => {
    expect(shellSplitWords("serve --host 0.0.0.0")).toEqual(["serve", "--host", "0.0.0.0"]);
  });
  it("keeps quoted spans intact", () => {
    expect(shellSplitWords(`node -e "console.log('a b')"`)).toEqual(["node", "-e", "console.log('a b')"]);
    expect(shellSplitWords(`--msg 'hello world'`)).toEqual(["--msg", "hello world"]);
  });
  it("honors backslash escapes", () => {
    expect(shellSplitWords("a\\ b c")).toEqual(["a b", "c"]);
  });
  it("keeps backslashes literal inside single quotes", () => {
    expect(shellSplitWords(`awk '{ gsub(/\\r/, ""); print }' /data/in`)).toEqual([
      "awk",
      `{ gsub(/\\r/, ""); print }`,
      "/data/in",
    ]);
    expect(shellSplitWords(`grep -E '\\d+' file.txt`)).toEqual(["grep", "-E", "\\d+", "file.txt"]);
  });
  it("keeps an empty quoted word as an empty argument", () => {
    expect(shellSplitWords(`node app.js --base-href ""`)).toEqual([
      "node",
      "app.js",
      "--base-href",
      "",
    ]);
    expect(shellSplitWords("echo '' end")).toEqual(["echo", "", "end"]);
  });
  it("empty / whitespace-only → []", () => {
    expect(shellSplitWords("")).toEqual([]);
    expect(shellSplitWords("   ")).toEqual([]);
  });
  it("does NOT interpret shell operators (they become literal argv)", () => {
    expect(shellSplitWords("a && b")).toEqual(["a", "&&", "b"]);
  });
});

describe("commandToArgv (compose semantics)", () => {
  it("null/undefined → null (keep image CMD)", () => {
    expect(commandToArgv(undefined)).toBeNull();
    expect(commandToArgv(null)).toBeNull();
  });
  it("string → tokenized argv", () => {
    expect(commandToArgv("serve --host x")).toEqual(["serve", "--host", "x"]);
  });
  it("empty string → [] (clear image CMD)", () => {
    expect(commandToArgv("")).toEqual([]);
  });
  it("array → argv verbatim (stringified)", () => {
    expect(commandToArgv(["serve", "--host", "0.0.0.0"])).toEqual(["serve", "--host", "0.0.0.0"]);
    expect(commandToArgv([])).toEqual([]);
  });
  it("explicit shell stays a shell invocation", () => {
    expect(commandToArgv(["sh", "-c", "a && b"])).toEqual(["sh", "-c", "a && b"]);
    expect(commandToArgv('sh -c "a && b"')).toEqual(["sh", "-c", "a && b"]);
  });
});
