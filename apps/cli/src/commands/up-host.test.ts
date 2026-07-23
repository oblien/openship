/**
 * Unit tests for resolveDashboardHost — run with:
 *   bun test apps/cli/src/commands/up-host.test.ts
 */
import { describe, expect, test } from "bun:test";
import { resolveDashboardHost } from "./up-host";

describe("resolveDashboardHost", () => {
  test("defaults to loopback when private", () => {
    expect(resolveDashboardHost({})).toBe("127.0.0.1");
  });

  test("binds all interfaces with --public-url (no managed edge)", () => {
    expect(
      resolveDashboardHost({ publicUrl: "https://ops.example.com" }),
    ).toBe("0.0.0.0");
  });

  test("stays on loopback under managed edge (OpenResty fronts it)", () => {
    expect(
      resolveDashboardHost({
        publicUrl: "https://ops.example.com",
        managedEdge: true,
      }),
    ).toBe("127.0.0.1");
  });

  test("--host overrides public-url / managed-edge defaults", () => {
    expect(resolveDashboardHost({ host: "0.0.0.0" })).toBe("0.0.0.0");
    expect(
      resolveDashboardHost({
        host: "10.0.0.5",
        publicUrl: "https://ops.example.com",
        managedEdge: true,
      }),
    ).toBe("10.0.0.5");
  });

  test("trims explicit host", () => {
    expect(resolveDashboardHost({ host: "  0.0.0.0  " })).toBe("0.0.0.0");
  });
});
