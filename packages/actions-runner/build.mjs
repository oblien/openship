import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { prepareRunnerModule } from "./prepare.mjs";
import { RUNNER_TARGETS, runnerFingerprint } from "./assets.mjs";
import { runnerNotices } from "./notices.mjs";

const directory = fileURLToPath(new URL(".", import.meta.url));
const output = join(directory, "dist");
mkdirSync(output, { recursive: true });
const targets = process.argv.includes("--native")
  ? [
      [
        process.platform === "darwin" ? "darwin" : "linux",
        process.arch === "arm64" ? "arm64" : "amd64",
      ],
    ]
  : RUNNER_TARGETS;
const files = {};
const modfile = prepareRunnerModule();
for (const [os, arch] of targets) {
  const name = `openship-actions-${os}-${arch}`;
  const result = spawnSync(
    "go",
    [
      "build",
      `-modfile=${modfile}`,
      "-trimpath",
      "-buildvcs=false",
      "-ldflags=-s -w",
      "-o",
      join(output, name),
      ".",
    ],
    {
      cwd: directory,
      env: { ...process.env, CGO_ENABLED: "0", GOOS: os, GOARCH: arch },
      stdio: "inherit",
    },
  );
  if (result.status !== 0) process.exit(result.status || 1);
  files[`${os}/${arch}`] = {
    name,
    sha256: createHash("sha256")
      .update(readFileSync(join(output, name)))
      .digest("hex"),
  };
}
writeFileSync(join(output, "THIRD_PARTY_NOTICES.txt"), runnerNotices(directory, modfile, targets));
writeFileSync(
  join(output, "manifest.json"),
  JSON.stringify(
    { protocol: 1, engine: "act/0.2.89", source: runnerFingerprint(), files },
    null,
    2,
  ) + "\n",
);
