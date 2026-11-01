import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each case loads the real auth routes, environment, encryption and SQLite in
// its own process. It cannot reuse another test's DB or touch a local mailbox.
describe("webmail sign-in", () => {
  for (const scenario of [
    "credentials",
    "unavailable",
    "session-refresh",
    "failed-reauth",
    "blank-hosts",
    "rate-limit",
  ]) {
    it(scenario, async () => {
      const dir = await mkdtemp(join(tmpdir(), "openship-webmail-auth-"));
      try {
        const child = Bun.spawn(
          [process.execPath, join(import.meta.dir, "fixtures/auth-case.ts"), scenario],
          {
            cwd: dir,
            env: {
              ...process.env,
              NODE_ENV: "test",
              SESSION_ENCRYPTION_KEY: "01".repeat(32),
              BRANDING_ADMIN_TOKEN: "test-only-branding",
              SQLITE_PATH: join(dir, "sessions.db"),
              DEFAULT_IMAP_HOST: "mail.example.test",
              DEFAULT_IMAP_PORT: "993",
              DEFAULT_SMTP_HOST: "mail.example.test",
              DEFAULT_SMTP_PORT: "465",
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [status, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect({ status, stdout, stderr }).toEqual({ status: 0, stdout: "", stderr: "" });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});
