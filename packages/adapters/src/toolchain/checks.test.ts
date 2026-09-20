import { describe, expect, it } from "vitest";

import { checkTool, meetsMinVersion } from "./checks";
import type { CommandExecutor } from "../types";

/**
 * What `checkTool` tells a server owner when a version probe does not answer.
 *
 * It reported one static sentence for two different faults: a tool that isn't installed,
 * and a tool whose `--version` was refused or timed out. Only the second can explain
 * itself, and the explanation is the whole diagnosis — this is #408 in the toolchain half,
 * where `system/checks.ts` had already been fixed and this had not.
 */

const host = (exec: (command: string) => Promise<string>) => ({ exec }) as unknown as CommandExecutor;

describe("checkTool", () => {
  it("reads the version off a tool that answered", async () => {
    const status = await checkTool(host(async () => "v22.11.0\n"), "node");
    expect(status).toMatchObject({ installed: true, healthy: true, version: "22.11.0" });
  });

  it("says only 'not installed' when the probe ran and found nothing", async () => {
    const status = await checkTool(host(async () => ""), "node");
    expect(status).toMatchObject({ installed: false, healthy: false });
    expect(status.message).toBe("Node.js is not installed");
  });

  it("names the cause when the probe itself was refused", async () => {
    const status = await checkTool(
      host(async () => {
        throw new Error("sh: 1: node: Permission denied");
      }),
      "node",
    );
    expect(status.installed).toBe(false);
    // The static sentence is kept as the headline — an operator scanning the list still
    // reads "not installed" — with the host's own words behind it.
    expect(status.message).toContain("Node.js is not installed");
    expect(status.message).toContain("Permission denied");
  });

  it("holds an installed tool to the stack's floor", async () => {
    const status = await checkTool(host(async () => "v18.0.0"), "node", { minVersion: "20" });
    expect(status).toMatchObject({
      installed: true,
      healthy: false,
      version: "18.0.0",
      requiredVersion: "20",
    });
  });

  it("does not probe at all for a tool the catalog has no recipe for", async () => {
    let probed = false;
    const status = await checkTool(
      host(async () => {
        probed = true;
        return "";
      }),
      "cobol",
    );
    expect(probed).toBe(false);
    expect(status).toMatchObject({ installed: false, healthy: false, message: "Unknown tool: cobol" });
  });
});

describe("meetsMinVersion", () => {
  it("compares by numeric part, not lexically", () => {
    expect(meetsMinVersion("22.11.0", "22.9.0")).toBe(true);
    expect(meetsMinVersion("1.10", "1.9")).toBe(true);
    expect(meetsMinVersion("18.20.4", "20")).toBe(false);
    expect(meetsMinVersion("20", "20.0.0")).toBe(true);
  });
});
