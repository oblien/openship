import { spawnSync } from "node:child_process";
import { directory, prepareRunnerModule } from "./prepare.mjs";
const command = process.argv.includes("--vet") ? "vet" : "test";
const options = process.argv.filter((arg) => arg === "-race");
if (command === "test") {
  const prepared = spawnSync(process.execPath, ["--test", "prepare.test.mjs"], {
    cwd: directory,
    stdio: "inherit",
  });
  if (prepared.status !== 0) process.exit(prepared.status ?? 1);
}
const result = spawnSync(
  "go",
  [command, `-modfile=${prepareRunnerModule()}`, ...options, "./..."],
  { cwd: directory, stdio: "inherit" },
);
process.exit(result.status ?? 1);
