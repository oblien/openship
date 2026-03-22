import type { CommandExecutor, SshConfig } from "../types";
import { LocalExecutor } from "./local-executor";
import { SshExecutor } from "./ssh-executor";

export { wrapLocalBuildCommand } from "./local-shell";
export { LocalExecutor } from "./local-executor";
export { SshExecutor } from "./ssh-executor";

export function createExecutor(ssh?: SshConfig): CommandExecutor {
  if (ssh) {
    return new SshExecutor(ssh);
  }
  return new LocalExecutor();
}
