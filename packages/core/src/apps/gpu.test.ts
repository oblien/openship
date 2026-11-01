import { describe, expect, it } from "vitest";
import { getAppTemplate } from "../app-templates";
import { isValidAppTemplate } from "./schema";
import { appGpuEnvironment, appServiceGpuConfig, resolveAppGpuMode } from "./gpu";

describe("catalog GPU installation", () => {
  const ollama = getAppTemplate("ollama")!;
  const service = ollama.services![0]!;
  it("defaults recommended apps to CPU and sends an exact NVIDIA request when selected", () => {
    expect(resolveAppGpuMode(ollama, undefined, false)).toBe(false);
    expect(appServiceGpuConfig(service, false)).toEqual({});
    expect(appServiceGpuConfig(service, true)).toEqual({
      gpus: [{ driver: "nvidia", count: 1, capabilities: ["gpu"] }],
    });
  });
  it("refuses required GPU downgrade and Cloud GPU requests", () => {
    const vllm = getAppTemplate("vllm")!;
    expect(resolveAppGpuMode(vllm, undefined, false)).toBe(true);
    expect(() => resolveAppGpuMode(vllm, false, false)).toThrow(/requires/);
    expect(() => resolveAppGpuMode(vllm, true, true)).toThrow(/Managed Cloud/);
    expect(() => resolveAppGpuMode(ollama, true, true)).toThrow(/Managed Cloud/);
    expect(() => resolveAppGpuMode(getAppTemplate("open-webui")!, true, false)).toThrow(
      /does not declare/,
    );
  });
  it("CPU mode disables implicit NVIDIA access and switching back preserves unrelated environment", () => {
    const cpu = appGpuEnvironment(service, false, { CUSTOM: "kept" });
    expect(cpu).toMatchObject({
      NVIDIA_VISIBLE_DEVICES: "void",
      CUDA_VISIBLE_DEVICES: "-1",
      CUSTOM: "kept",
    });
    const gpu = appGpuEnvironment(service, true, cpu);
    expect(gpu.CUSTOM).toBe("kept");
    expect(gpu).not.toHaveProperty("NVIDIA_VISIBLE_DEVICES");
    expect(gpu).not.toHaveProperty("CUDA_VISIBLE_DEVICES");
  });
  it("rejects compatibility fields on old shapes and invalid GPU selectors instead of silently widening", () => {
    expect(isValidAppTemplate({ ...ollama, schemaVersion: 1 })).toBe(false);
    expect(isValidAppTemplate({ ...ollama, services: [{ ...service, gpus: { count: -2 } }] })).toBe(
      false,
    );
    expect(
      isValidAppTemplate({
        ...ollama,
        services: [{ ...service, gpus: { count: 1, deviceIds: ["0"] } }],
      }),
    ).toBe(false);
    expect(isValidAppTemplate({ ...ollama, services: [{ ...service, gpus: null }] })).toBe(false);
  });
});
