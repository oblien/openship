import { describe, expect, it } from "vitest";

import { resolveRestartPolicy } from "../src/runtime/docker";

describe("resolveRestartPolicy", () => {
  it("maps the plain policy names", () => {
    expect(resolveRestartPolicy("always")).toEqual({ Name: "always", MaximumRetryCount: 0 });
    expect(resolveRestartPolicy("unless-stopped")).toEqual({
      Name: "unless-stopped",
      MaximumRetryCount: 0,
    });
    expect(resolveRestartPolicy("no")).toEqual({ Name: "no", MaximumRetryCount: 0 });
    expect(resolveRestartPolicy("on-failure")).toEqual({
      Name: "on-failure",
      MaximumRetryCount: 5,
    });
  });

  it("defaults an omitted policy to always", () => {
    expect(resolveRestartPolicy(undefined)).toEqual({ Name: "always", MaximumRetryCount: 0 });
  });

  it("honours Compose's on-failure:<max-retries> instead of restarting forever", () => {
    expect(resolveRestartPolicy("on-failure:3")).toEqual({
      Name: "on-failure",
      MaximumRetryCount: 3,
    });
    expect(resolveRestartPolicy(" on-failure:10 ")).toEqual({
      Name: "on-failure",
      MaximumRetryCount: 10,
    });
  });
});
