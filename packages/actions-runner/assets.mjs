/** Build-time only: every distribution stages the same verified runner assets. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installRunnerArtifact, validateRunnerArtifact } from "./distribution.mjs";

export const RUNNER_TARGETS = [
  ["linux", "amd64"],
  ["linux", "arm64"],
  ["darwin", "amd64"],
  ["darwin", "arm64"],
];
export const runnerDirectory = dirname(fileURLToPath(import.meta.url));
const output = join(runnerDirectory, "dist");

export function runnerFingerprint(sourceDirectory = runnerDirectory) {
  const hash = createHash("sha256");
  // Only compilation inputs identify the worker. Transport helpers, tests and
  // documentation changes can keep reusing the already-built binary release.
  for (const name of readdirSync(sourceDirectory)
    .filter(
      (name) =>
        (name.endsWith(".go") && !name.endsWith("_test.go")) ||
        (name.endsWith(".cjs") && !name.endsWith(".test.cjs")) ||
        [
          "assets.mjs",
          "build.mjs",
          "prepare.mjs",
          "notices.mjs",
          "go.mod",
          "go.sum",
          "NOTICE",
        ].includes(name),
    )
    .sort()) {
    hash.update(name);
    hash.update(readFileSync(join(sourceDirectory, name)));
  }
  return hash.digest("hex");
}

export const RUNNER_ASSET_NAMES = [
  "manifest.json",
  "THIRD_PARTY_NOTICES.txt",
  ...RUNNER_TARGETS.map(([os, arch]) => `openship-actions-${os}-${arch}`),
];

export function runnerArtifact() {
  const value = JSON.parse(readFileSync(join(runnerDirectory, "artifact.json"), "utf8"));
  return value === null ? null : validateRunnerArtifact(value);
}

export function verifyRunnerAssets(directory = output) {
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  if (manifest.protocol !== 1 || manifest.engine !== "act/0.2.89")
    throw new Error("Actions runner protocol or engine does not match this build");
  if (manifest.source !== runnerFingerprint())
    throw new Error("Actions runner assets need rebuilding");
  for (const [os, arch] of RUNNER_TARGETS) {
    const file = manifest.files[`${os}/${arch}`];
    if (
      file?.name !== `openship-actions-${os}-${arch}` ||
      createHash("sha256")
        .update(readFileSync(join(directory, file.name)))
        .digest("hex") !== file.sha256
    )
      throw new Error(`Missing or invalid Actions runner for ${os}/${arch}`);
  }
  if (!readFileSync(join(directory, "THIRD_PARTY_NOTICES.txt"), "utf8").includes("nektos/act"))
    throw new Error("Actions runner license notices are missing");
  return manifest;
}

export function ensureRunnerAssets() {
  try {
    return verifyRunnerAssets();
  } catch {
    /* Resolve a complete compatible release; never stage a partial target set. */
  }
  const published =
    process.env.OPENSHIP_ACTIONS_RUNNER_BUILD !== "1" &&
    runnerArtifact()?.source === runnerFingerprint();
  const result = spawnSync(
    process.execPath,
    [
      join(runnerDirectory, published ? "assets.mjs" : "build.mjs"),
      ...(published ? ["--install"] : []),
    ],
    {
      stdio: "inherit",
    },
  );
  if (result.status !== 0)
    throw new Error(
      published
        ? "Could not fetch the pinned Actions worker release. Retry the build, or explicitly use OPENSHIP_ACTIONS_RUNNER_BUILD=1 with the declared Go toolchain."
        : "Actions runner build failed. Custom worker source requires the Go toolchain declared in packages/actions-runner/go.mod.",
    );
  return verifyRunnerAssets();
}

export function stageActionRunnerAssets(target) {
  ensureRunnerAssets();
  mkdirSync(target, { recursive: true });
  for (const name of RUNNER_ASSET_NAMES) cpSync(join(output, name), join(target, name));
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  if (process.argv.includes("--install")) {
    const descriptor = runnerArtifact();
    if (descriptor?.source !== runnerFingerprint())
      throw new Error("The pinned Actions worker release is stale for this source");
    await installRunnerArtifact(descriptor, output, {
      verify: verifyRunnerAssets,
      names: RUNNER_ASSET_NAMES,
    });
  } else if (process.argv.includes("--verify")) {
    verifyRunnerAssets();
  } else {
    ensureRunnerAssets();
  }
}
