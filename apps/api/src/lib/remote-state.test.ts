import { describe, expect, it } from "vitest";

import { isConnectionLoss } from "@repo/platform/engine/lib/remote-state";

describe("isConnectionLoss", () => {
  it("recognizes a serialized ssh2 exec-request rejection", () => {
    expect(isConnectionLoss(new Error("Unable to exec"))).toBe(true);
    expect(isConnectionLoss("Unable to exec")).toBe(true);
  });

  it("does not classify lookalike remote command failures as connection loss", () => {
    expect(isConnectionLoss(new Error("sudo: unable to execute helper"))).toBe(false);
    expect(isConnectionLoss("sudo: unable to execute helper")).toBe(false);
  });
});
