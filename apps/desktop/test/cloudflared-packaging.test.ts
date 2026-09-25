import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudflaredRelease, downloadCloudflared, stageCloudflared, verifyCloudflaredAsset } from "../scripts/fetch-cloudflared.mjs";

const directories: string[] = [];
const directory = () => { const dir = mkdtempSync(join(tmpdir(), "openship-cf-package-")); directories.push(dir); return dir; };
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("pinned Windows Cloudflare client", () => {
  it("pins both the executable and its license to one release and SHA-256", () => {
    expect(cloudflaredRelease.files.map((asset: { name: string }) => asset.name)).toEqual(["cloudflared.exe", "LICENSE"]);
    for (const asset of cloudflaredRelease.files) {
      expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(asset.url).toContain(`/${cloudflaredRelease.version}/`);
    }
  });
  it("rejects altered downloads before creating an executable", async () => {
    const target = directory();
    await expect(downloadCloudflared(target, async () => new Response("untrusted binary"))).rejects.toThrow(/integrity/);
    expect(readdirSync(target)).toEqual([]);
  });
  it("refuses missing and modified assets when packaging Windows", () => {
    const source = directory();
    const target = directory();
    expect(() => stageCloudflared(source, target, "win32", "x64")).toThrow(/fetch-cloudflared/);
    writeFileSync(join(source, "cloudflared.exe"), "untrusted binary");
    expect(() => stageCloudflared(source, target, "win32", "x64")).toThrow(/integrity/);
    expect(readdirSync(target)).toEqual([]);
    expect(() => verifyCloudflaredAsset("LICENSE", Buffer.from("untrusted license"))).toThrow(/integrity/);
  });
  it("does not package a Windows executable for other platforms", () => {
    const source = directory(); const target = directory();
    expect(() => stageCloudflared(source, target, "linux", "arm64")).not.toThrow();
    expect(readdirSync(target)).toEqual([]);
    expect(() => stageCloudflared(source, target, "win32", "arm64")).toThrow(/Windows x64/);
  });
});
