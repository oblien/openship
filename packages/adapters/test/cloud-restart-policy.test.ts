import { describe, expect, it } from "vitest";

import { restartPolicyForWorkload } from "../src/runtime/cloud/compose";

describe("restartPolicyForWorkload", () => {
  it("maps the plain compose restart values", () => {
    expect(restartPolicyForWorkload("no")).toBe("never");
    expect(restartPolicyForWorkload("never")).toBe("never");
    expect(restartPolicyForWorkload("on-failure")).toBe("on-failure");
    expect(restartPolicyForWorkload("always")).toBe("always");
    expect(restartPolicyForWorkload("unless-stopped")).toBe("always");
  });

  it("maps `on-failure:<max-retries>` to on-failure, not always", () => {
    expect(restartPolicyForWorkload("on-failure:5")).toBe("on-failure");
    expect(restartPolicyForWorkload("on-failure:1")).toBe("on-failure");
  });

  it("defaults to always for an unset or unknown policy", () => {
    expect(restartPolicyForWorkload(undefined)).toBe("always");
    expect(restartPolicyForWorkload("")).toBe("always");
  });
});
