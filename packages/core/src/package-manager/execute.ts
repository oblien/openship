import * as cp from "node:child_process";
const toolEnv = { ...process.env, COREPACK_DEFAULT_TO_LATEST: "0", COREPACK_ENABLE_AUTO_PIN: "0" };
const execute = (command: string, args: string[], capture = false) =>
  cp.spawnSync(command, args, {
    stdio: capture ? "pipe" : "inherit",
    encoding: "utf8",
    env: toolEnv,
  });
export const run = (command: string, args: string[]) => execute(command, args).status === 0;
export const versionOf = (command: string, args = ["--version"]) => {
  const result = execute(command, args, true);
  return result.status === 0 ? result.stdout.trim() : undefined;
};
