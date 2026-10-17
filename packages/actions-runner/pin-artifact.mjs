/** Lock an already-published artifact; never follow a mutable runtime tag. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runnerDirectory, runnerFingerprint, verifyRunnerAssets } from "./assets.mjs";
import { validateRunnerArtifact } from "./distribution.mjs";
import { join } from "node:path";

verifyRunnerAssets();
const descriptor = validateRunnerArtifact({
  schemaVersion: 1,
  source: runnerFingerprint(),
  image: process.argv[2],
});
writeFileSync(join(runnerDirectory, "artifact.json"), JSON.stringify(descriptor, null, 2) + "\n");
const dockerfile = fileURLToPath(new URL("../../apps/api/Dockerfile", import.meta.url));
const source = readFileSync(dockerfile, "utf8");
if (/^ARG ACTIONS_RUNNER_IMAGE=/m.test(source))
  writeFileSync(
    dockerfile,
    source.replace(
      /^ARG ACTIONS_RUNNER_IMAGE=.*$/m,
      `ARG ACTIONS_RUNNER_IMAGE=${descriptor.image}`,
    ),
  );
console.log(JSON.stringify(descriptor));
