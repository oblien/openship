import { execFile } from "node:child_process";

/** One-shot exec attempt — resolves to the trimmed stdout on success,
 *  or an error object the caller can log. Used to walk fallback paths
 *  without burying the actual ENOENT/EPERM under a silent null. */
export function probeLocalGitHubToken(
  bin: string,
): Promise<{ token: string } | { error: NodeJS.ErrnoException; stderr?: string }> {
  return new Promise((resolve) => {
    execFile(bin, ["auth", "token"], { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) return resolve({ error: err as NodeJS.ErrnoException, stderr: stderr?.toString() });
      const t = stdout.trim();
      if (!t) {
        return resolve({
          error: Object.assign(new Error("gh auth token returned empty"), { code: "EMPTY" }),
          stderr: stderr?.toString(),
        });
      }
      resolve({ token: t });
    });
  });
}
