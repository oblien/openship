import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const cloudflaredRelease = JSON.parse(readFileSync(join(desktop, "build/cloudflared.json"), "utf8"));

export function verifyCloudflaredAsset(name, bytes) {
  const expected = cloudflaredRelease.files.find(file => file.name === name)?.sha256;
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (!expected || actual !== expected) throw new Error(`Cloudflare client integrity check failed for ${name}. Re-download the pinned release.`);
}

/** Downloads build inputs only. The desktop never downloads an executable at runtime. */
export async function downloadCloudflared(destination = join(desktop, "assets/cloudflared"), fetchImpl = fetch) {
  mkdirSync(destination, { recursive: true });
  for (const asset of cloudflaredRelease.files) {
    const response = await fetchImpl(asset.url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok || !response.body) throw new Error(`Could not download ${asset.name}: HTTP ${response.status}`);
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 64 * 1024 * 1024) throw new Error(`Cloudflare client download exceeds the size limit: ${asset.name}`);
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    verifyCloudflaredAsset(asset.name, bytes);
    const temporary = join(destination, `.${asset.name}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      await writeFile(temporary, bytes);
      await rename(temporary, join(destination, asset.name));
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

/** Re-verify before packaging; local builds follow the same rule as CI. */
export function stageCloudflared(source, destination, platform, arch) {
  mkdirSync(destination, { recursive: true });
  if (platform !== "win32") return;
  if (arch !== "x64") throw new Error("The bundled Cloudflare client currently supports Windows x64.");
  for (const asset of cloudflaredRelease.files) {
    const path = join(source, asset.name);
    let bytes;
    try { bytes = readFileSync(path); }
    catch { throw new Error("Run node apps/desktop/scripts/fetch-cloudflared.mjs before packaging the Windows desktop."); }
    verifyCloudflaredAsset(asset.name, bytes);
    copyFileSync(path, join(destination, asset.name));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const outputIndex = process.argv.indexOf("--output");
  await downloadCloudflared(outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined);
  process.stdout.write(`Verified cloudflared ${cloudflaredRelease.version} and its license.\n`);
}
