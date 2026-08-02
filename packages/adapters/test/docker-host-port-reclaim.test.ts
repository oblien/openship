import { describe, expect, it } from "vitest";

import {
  hostPortsFromBindings,
  isPortAlreadyAllocatedError,
} from "../src/runtime/docker";

describe("isPortAlreadyAllocatedError", () => {
  it("matches Docker's bind failure message", () => {
    expect(
      isPortAlreadyAllocatedError(
        new Error(
          "Bind for 127.0.0.1:20000 failed: port is already allocated",
        ),
      ),
    ).toBe(true);
  });

  it("matches address already in use", () => {
    expect(isPortAlreadyAllocatedError(new Error("listen tcp :20000: bind: address already in use"))).toBe(
      true,
    );
  });

  it("ignores unrelated errors", () => {
    expect(isPortAlreadyAllocatedError(new Error("no such image"))).toBe(false);
    expect(isPortAlreadyAllocatedError(null)).toBe(false);
  });
});

describe("hostPortsFromBindings", () => {
  it("extracts pinned host ports from PortBindings", () => {
    expect(
      hostPortsFromBindings({
        "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "20000" }],
        "5432/tcp": [{ HostPort: "25432" }],
      }),
    ).toEqual([20000, 25432]);
  });

  it("skips empty / missing HostPort entries", () => {
    expect(
      hostPortsFromBindings({
        "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
        "80/tcp": null,
      }),
    ).toEqual([]);
  });
});
