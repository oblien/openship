import { describe, expect, it } from "vitest";

import { targetSourceCloneSupportedForTopology } from "../../src/lib/source-clone-topology";

describe("targetSourceCloneSupportedForTopology", () => {
  it("supports bare source acquisition through the target executor", () => {
    expect(targetSourceCloneSupportedForTopology("bare", false)).toBe(true);
    expect(targetSourceCloneSupportedForTopology("bare", true)).toBe(true);
  });

  it("supports Docker target acquisition only on a remote SSH server", () => {
    expect(targetSourceCloneSupportedForTopology("docker", false)).toBe(true);
    expect(targetSourceCloneSupportedForTopology("docker", true)).toBe(false);
  });
});
