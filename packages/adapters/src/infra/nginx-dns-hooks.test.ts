import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { LocalExecutor } from "../system/local-executor";
import type { RootChecked } from "../system/privilege";
import { NginxProvider } from "./nginx";
import { OPENRESTY_DEFAULT_PATHS } from "./openresty-lua";

const execute = promisify(execFile);
const authScript = `#!/bin/sh
set -eu
printf '%s\\n' "$OPENSHIP_DNS_RECORD_FILE" >> "$HOOK_LOG"
printf '%s\\n' "$CERTBOT_DOMAIN:$CERTBOT_VALIDATION" > "$OPENSHIP_DNS_RECORD_FILE"
`;
const cleanupScript = `#!/bin/sh
set -eu
printf '%s\\n' "$OPENSHIP_DNS_RECORD_FILE" >> "$HOOK_LOG"
test "$(cat "$OPENSHIP_DNS_RECORD_FILE")" = "$CERTBOT_DOMAIN:$CERTBOT_VALIDATION"
rm "$OPENSHIP_DNS_RECORD_FILE"
`;

test.each([
  { method: "provisionCert", directory: "edge", cleanup: true },
  {
    method: "provisionCert",
    directory: 'edge\'s "quoted" $(touch QUOTING_BROKEN) directory',
    cleanup: true,
  },
  { method: "renewCert", directory: "edge's renewal directory", cleanup: true },
  { method: "provisionCert", directory: "edge without cleanup", cleanup: false },
] as const)(
  "$method validates and executes DNS hooks in $directory",
  async ({ method, directory, cleanup }) => {
    const scratch = await mkdtemp(join(tmpdir(), "openship-dns-hooks-"));
    const root = join(scratch, directory);
    const log = join(scratch, "hooks.log");
    const calls: string[][] = [];
    const executor = new LocalExecutor();

    // Real target file operations and POSIX shell execution. Only Certbot/ACME
    // issuance is replaced; generated hooks still have to be executable on disk.
    executor.exec = async (command) => {
      if (!command.startsWith("certbot ")) {
        return (await execute("/bin/sh", ["-c", command], { cwd: scratch })).stdout;
      }
      const { stdout } = await execute(
        "/bin/sh",
        ["-c", `certbot() { printf '%s\\0' "$@"; }\n${command}`],
        { cwd: scratch },
      );
      const args = stdout.split("\0").slice(0, -1);
      calls.push(args);
      expect(args).not.toContain("--disable-hook-validation");
      const hooks = ["--manual-auth-hook", "--manual-cleanup-hook"].flatMap((flag) => {
        const index = args.indexOf(flag);
        return index === -1 ? [] : [args[index + 1]];
      });
      expect(hooks).toHaveLength(cleanup ? 2 : 1);
      for (const hook of hooks) {
        // Certbot's validate_hook checks the first whitespace-delimited word,
        // before the shell interprets assignments or quotes. Check its executable
        // against the real PATH, so an assignment-only prefix reproduces #1053.
        const executable = hook.split(/\s+/, 1)[0];
        await execute("/bin/sh", ["-c", 'command -v "$1"', "validate-hook", executable], {
          cwd: scratch,
        });
      }
      for (const hook of hooks) {
        await execute("/bin/sh", ["-c", hook], {
          cwd: scratch,
          env: {
            ...process.env,
            HOOK_LOG: log,
            CERTBOT_DOMAIN: "app.example.com",
            CERTBOT_VALIDATION: "dns-proof",
          },
        });
      }
      // No CA is contacted or certificate fabricated in this hook regression.
      return "DNS hooks executed";
    };

    const nginx = new NginxProvider({
      paths: { ...OPENRESTY_DEFAULT_PATHS, sitesDir: join(scratch, "sites-enabled") },
      certDir: join(root, "live"),
      executor: executor as RootChecked,
    });
    try {
      await expect(
        nginx[method]("app.example.com", {
          challenge: "dns-01",
          dnsAuthHookScript: authScript,
          ...(cleanup ? { dnsCleanupHookScript: cleanupScript } : {}),
        }),
      ).rejects.toThrow("no certificate is at");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("certonly");
      if (method === "renewCert") expect(calls[0]).toContain("--force-renewal");
      const records = (await readFile(log, "utf8")).trimEnd().split("\n");
      expect(records).toHaveLength(cleanup ? 2 : 1);
      expect(new Set(records).size).toBe(1);
      expect(basename(records[0])).toBe("record-id.txt");
      expect(dirname(dirname(records[0]))).toBe(root);
      await expect(stat(dirname(records[0]))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(scratch)).not.toContain("QUOTING_BROKEN");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
