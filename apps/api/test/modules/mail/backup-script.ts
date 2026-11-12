import { execFileSync } from "node:child_process";
import { expect } from "vitest";

/** Decode the one root shell argument without executing its contents. Tests
 * inspect the actual script, independent of its outer shell-quoting layer. */
export function backupScript(command: string): string {
  expect(command).toMatch(/^sudo -n sh -c /);
  return execFileSync("sh", ["-c", command.replace(/^sudo -n sh -c /, "printf '%s' ")], {
    encoding: "utf8",
  });
}
