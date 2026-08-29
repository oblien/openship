import { describe, expect, it } from "vitest";

import { defaultDomainType } from "./default-domain-type";

describe("defaultDomainType", () => {
  it("offers the free subdomain when Cloud is available", () => {
    // True on SaaS/native too: CloudContext forces `connected` there.
    expect(defaultDomainType(true)).toBe("free");
  });

  it("defaults to the user's own domain when Cloud is not connected", () => {
    // Free `.opsh.io` needs Cloud (backend preflight gates it), so seeding it on a
    // Cloud-less self-hosted instance would offer a dead end.
    expect(defaultDomainType(false)).toBe("custom");
  });
});
