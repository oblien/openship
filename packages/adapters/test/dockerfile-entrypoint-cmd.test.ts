import { describe, expect, it } from "vitest";

import { compileDockerfileToWorkspacePlan } from "../src/dockerfile/compiler";

function startCommand(dockerfile: string): string | undefined {
  return compileDockerfileToWorkspacePlan(dockerfile).runtime?.startCommand;
}

// Expectations follow Docker's documented ENTRYPOINT/CMD interaction table.
// The shell form of ENTRYPOINT runs the image as `/bin/sh -c "<entrypoint>"`,
// which takes no arguments — so any CMD (and run-time args) is dropped.
describe("compileDockerfileToWorkspacePlan — ENTRYPOINT/CMD combination", () => {
  it("drops CMD when ENTRYPOINT is shell form (exec CMD)", () => {
    expect(startCommand(`FROM node:20\nENTRYPOINT ./start.sh\nCMD ["--flag"]`)).toBe("./start.sh");
  });

  it("drops CMD when ENTRYPOINT is shell form (shell CMD)", () => {
    expect(startCommand(`FROM node:20\nENTRYPOINT ./start.sh\nCMD --flag`)).toBe("./start.sh");
  });

  it("drops CMD regardless of instruction order", () => {
    expect(startCommand(`FROM node:20\nCMD ["--flag"]\nENTRYPOINT ./start.sh`)).toBe("./start.sh");
  });

  it("appends CMD as arguments when ENTRYPOINT is exec form", () => {
    expect(
      startCommand(`FROM node:20\nENTRYPOINT ["node","server.js"]\nCMD ["--port","3000"]`),
    ).toBe("node server.js --port 3000");
  });

  it("uses CMD alone when there is no ENTRYPOINT", () => {
    expect(startCommand(`FROM node:20\nCMD ["node","server.js"]`)).toBe("node server.js");
  });

  it("uses a shell-form ENTRYPOINT alone", () => {
    expect(startCommand(`FROM node:20\nENTRYPOINT ./start.sh`)).toBe("./start.sh");
  });
});
