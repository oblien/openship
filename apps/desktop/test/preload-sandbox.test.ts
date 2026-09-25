import { describe, expect, it, vi } from "vitest";
import { build, type BuildOptions } from "esbuild";
import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";
import { desktopBuildOptions } from "../build/options.mjs";

describe("sandboxed desktop preload", () => {
  it("loads the real bundled bridge with only Electron available and retains validation", async () => {
    const options = desktopBuildOptions.find((option: { outfile: string }) => option.outfile.includes("/preload/"));
    const result = await build({ ...options, write: false, logLevel: "silent" } as BuildOptions);
    const expose = vi.fn();
    runInNewContext(result.outputFiles![0]!.text, {
      require: (name: string) => {
        if (name !== "electron") throw new Error(`Sandbox cannot load ${name}`);
        return { contextBridge: { exposeInMainWorld: expose }, ipcRenderer: {} };
      },
      process: { platform: "linux" },
    });
    expect(expose).toHaveBeenCalledOnce();
    expect(expose.mock.calls[0]![0]).toBe("desktop");
    const bridge = expose.mock.calls[0]![1];
    expect(bridge.utils.isPrivateIp("10.0.0.1")).toBe(true);
    expect(bridge.utils.validateServerAddress("")).toBe("Please enter your server IP address");
    expect(bridge.utils.validateServerAddress("server.example.test")).toBeNull();
  });
  it("enables the sandbox in both windows", () => {
    for (const file of ["index.ts", "update-window.ts"]) {
      const code = readFileSync(new URL(`../src/main/${file}`, import.meta.url), "utf8");
      expect(code).toContain("sandbox: true");
      expect(code).not.toContain("sandbox: false");
    }
  });
});
