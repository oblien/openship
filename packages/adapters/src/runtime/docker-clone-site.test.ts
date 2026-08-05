import { describe, expect, it } from "vitest";

import { assertCloneOnServerTransport } from "./docker";

describe("assertCloneOnServerTransport", () => {
  it("accepts target-host acquisition only with SSH plus a command executor", () => {
    expect(() => assertCloneOnServerTransport("ssh", true, true)).not.toThrow();
  });

  it.each(["socket", "tcp"] as const)("rejects cloneOnServer for the %s transport", (kind) => {
    expect(() => assertCloneOnServerTransport(kind, false, true)).toThrow(
      /requires the Docker SSH transport/,
    );
  });

  it("rejects an SSH transport without a target command executor", () => {
    expect(() => assertCloneOnServerTransport("ssh", false, true)).toThrow(
      /requires the Docker SSH transport/,
    );
  });

  it("allows API-host staging on every transport", () => {
    expect(() => assertCloneOnServerTransport("socket", false, false)).not.toThrow();
    expect(() => assertCloneOnServerTransport("tcp", false, undefined)).not.toThrow();
  });
});
