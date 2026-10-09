/** Build-time only: every distribution stages the same verified runner assets. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const RUNNER_TARGETS = [
  ["linux", "amd64"],
  ["linux", "arm64"],
  ["darwin", "amd64"],
  ["darwin", "arm64"],
];
export const runnerDirectory = dirname(fileURLToPath(import.meta.url));
const output = join(runnerDirectory, "dist");

export function runnerFingerprint() {
  const hash = createHash("sha256");
  for (const name of readdirSync(runnerDirectory)
    .filter((name) => /\.(?:go|mjs)$/.test(name) || ["go.mod", "go.sum", "NOTICE"].includes(name))
    .sort()) {
    hash.update(name);
    hash.update(readFileSync(join(runnerDirectory, name)));
  }
  return hash.digest("hex");
}

export function verifyRunnerAssets() {
  const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
  if (manifest.source !== runnerFingerprint())
    throw new Error("Actions runner assets need rebuilding");
  for (const [os, arch] of RUNNER_TARGETS) {
    const file = manifest.files[`${os}/${arch}`];
    if (
      file?.name !== `openship-actions-${os}-${arch}` ||
      createHash("sha256")
        .update(readFileSync(join(output, file.name)))
        .digest("hex") !== file.sha256
    )
      throw new Error(`Missing or invalid Actions runner for ${os}/${arch}`);
  }
  if (!readFileSync(join(output, "THIRD_PARTY_NOTICES.txt"), "utf8").includes("nektos/act"))
    throw new Error("Actions runner license notices are missing");
  return manifest;
}

export function ensureRunnerAssets() {
  try {
    return verifyRunnerAssets();
  } catch {
    /* A missing/stale build is rebuilt, never shipped as a partial target set. */
  }
  const result = spawnSync(process.execPath, [join(runnerDirectory, "build.mjs")], {
    stdio: "inherit",
  });
  if (result.status !== 0)
    throw new Error(
      "Actions runner build failed. Building Openship requires the Go toolchain declared in packages/actions-runner/go.mod.",
    );
  return verifyRunnerAssets();
}

export function stageActionRunnerAssets(target) {
  const manifest = ensureRunnerAssets();
  mkdirSync(target, { recursive: true });
  for (const name of [
    "manifest.json",
    "THIRD_PARTY_NOTICES.txt",
    ...Object.values(manifest.files).map((file) => file.name),
  ])
    cpSync(join(output, name), join(target, name));
}
