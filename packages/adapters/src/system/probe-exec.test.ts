import { describe, expect, it, vi } from "vitest";

import { SshDisconnectedError, SshExecRequestError } from "./errors";
import { probeExec, tryExec, withReason } from "./probe-exec";
import type { ExecOnly } from "../types";

/**
 * The `null`-vs-`""` distinction, pinned where it now lives.
 *
 * These helpers were eight copies before this file existed, and the copies had already
 * drifted — one of them lost the reporting half. Consolidating them is only a fix if the
 * two behaviors that made the copies differ are held down: a refused probe is not an empty
 * one, and a dropped transport is not either.
 */

const throwing = (err: unknown): ExecOnly => ({
  exec: async () => {
    throw err;
  },
});

describe("tryExec", () => {
  it("distinguishes a command that failed from one that printed nothing", async () => {
    expect(await tryExec(throwing(new Error("boom")), "x")).toBeNull();
    expect(await tryExec({ exec: async () => "" }, "x")).toBe("");
  });

  it("swallows a dropped transport too — its callers have a next tier to try", async () => {
    expect(await tryExec(throwing(new SshDisconnectedError()), "x")).toBeNull();
  });

  it("omits the options argument entirely when the caller passed none", async () => {
    const exec = vi.fn(async () => "out");
    await tryExec({ exec }, "uname -m");
    expect(exec).toHaveBeenCalledWith("uname -m");

    await tryExec({ exec }, "uname -m", { timeout: 10_000 });
    expect(exec).toHaveBeenLastCalledWith("uname -m", { timeout: 10_000 });
  });
});

describe("probeExec", () => {
  it("keeps the failure text rather than reducing it to an absence", async () => {
    const outcome = await probeExec(
      throwing(new Error("permission denied while trying to connect to the Docker daemon socket")),
      "docker info",
      "test",
    );
    expect(outcome.output).toBe("");
    expect(outcome.error).toContain("permission denied");
  });

  it("reports a command that answered nothing with no error to explain", async () => {
    expect(await probeExec({ exec: async () => "  \n " }, "docker info", "test")).toEqual({
      output: "",
      error: null,
    });
  });

  it("names the command when the failure carried no message of its own", async () => {
    const outcome = await probeExec(throwing(new Error("")), "git --version", "test");
    expect(outcome.error).toContain("git --version");
  });

  it("re-throws a dropped transport instead of reporting the host as empty", async () => {
    // The invariant the duplicated copies risked losing: an unreachable host must abort the
    // whole check, not be recorded component-by-component as a box with nothing installed.
    await expect(probeExec(throwing(new SshDisconnectedError()), "git --version", "test")).rejects.toThrow(
      SshDisconnectedError,
    );
  });

  it("re-throws 'Unable to exec' channel failure instead of reporting component as missing", async () => {
    const failure = new SshExecRequestError(new Error("Unable to exec"));
    await expect(probeExec(throwing(failure), "git --version", "test")).rejects.toThrow(SshExecRequestError);
  });

  it("keeps lookalike command stderr as an ordinary probe failure", async () => {
    const outcome = await probeExec(
      throwing(new Error("sudo: unable to execute helper: Permission denied")),
      "git --version",
      "test",
    );
    expect(outcome).toEqual({
      output: "",
      error: "sudo: unable to execute helper: Permission denied",
    });
  });

  it("trims the output it reports", async () => {
    expect((await probeExec({ exec: async () => "git version 2.43.0\n" }, "g", "test")).output).toBe(
      "git version 2.43.0",
    );
  });
});

describe("withReason", () => {
  it("leaves the message alone when there is nothing to add", () => {
    expect(withReason("Docker is not installed", null)).toBe("Docker is not installed");
    expect(withReason("Docker is not installed", "  \n ")).toBe("Docker is not installed");
  });

  it("appends the first line only, capped", () => {
    expect(withReason("msg", "  cause here  \nstack frame\nanother")).toBe("msg — cause here");
    const long = withReason("msg", "x".repeat(400));
    expect(long.length).toBeLessThan(220);
    expect(long.endsWith("…")).toBe(true);
  });
});
