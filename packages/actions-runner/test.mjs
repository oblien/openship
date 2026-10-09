import { spawnSync } from "node:child_process";
import { directory, prepareRunnerModule } from "./prepare.mjs";
const command = process.argv.includes("--vet") ? "vet" : "test";
const options = process.argv.filter((arg) => arg === "-race");
const result = spawnSync(
  "go",
  [command, `-modfile=${prepareRunnerModule()}`, ...options, "./..."],
  { cwd: directory, stdio: "inherit" },
);
process.exit(result.status ?? 1);
