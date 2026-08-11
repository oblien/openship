/**
 * Regression guard for the mail-admin OS command injection (heredoc delimiter
 * injection). `transaction()` must NEVER build a heredoc: a fixed delimiter let
 * a mailbox display name containing a line equal to that delimiter close it
 * early and run the following lines as shell commands (as root over SSH).
 * The fix runs the whole transaction as a single shell-quoted `-c` argument.
 */

import "./_setup-env"; // MUST be first — sets INTERNAL_TOKEN before config/env loads
import { describe, expect, test } from "vitest";
import type { CommandExecutor } from "@repo/adapters";
import { transaction } from "../../../src/modules/mail/admin/psql-runner";

function capturingExecutor(sink: string[]): CommandExecutor {
  return {
    exec: async (cmd: string) => {
      sink.push(cmd);
      return "";
    },
  } as unknown as CommandExecutor;
}

// The exact PoC payload from the report, embedded in a mailbox INSERT.
const EVIL_NAME =
  "PoC\n__OPENSHIP_SQL_EOF__\n(id; hostname) > /tmp/CURL_RCE_PROOF 2>&1\n#";
const EVIL_STATEMENT = `INSERT INTO mailbox (username, name) VALUES ('a@b.com', '${EVIL_NAME.replace(/'/g, "''")}')`;

describe("psql-runner transaction() — command injection is neutralized", () => {
  test("never emits a heredoc, and single quotes in the payload are escaped", async () => {
    const cmds: string[] = [];
    await transaction(capturingExecutor(cmds), [EVIL_STATEMENT]);
    expect(cmds).toHaveLength(1);
    // No heredoc at all → the delimiter text (which DOES appear as inert data
    // inside the quoted arg) has nothing to terminate.
    expect(cmds[0]).not.toContain("<<");
    // shellQuote wrapped the SQL: any inner single quote becomes '\'' so the
    // payload cannot break out of the -c argument.
    expect(cmds[0]).toContain("'\\''");
  });

  test("passes the whole transaction as one shell-quoted -c argument", async () => {
    const cmds: string[] = [];
    await transaction(capturingExecutor(cmds), [EVIL_STATEMENT]);
    const cmd = cmds[0];
    expect(cmd).toContain("sudo -u postgres psql -d vmail");
    expect(cmd).toContain(" -c '");
    // Everything after `-c '` up to the closing quote is a single argv token;
    // any inner single quote is escaped as '\'' so the payload can't break out.
    expect(cmd.startsWith("sudo -u postgres psql -d vmail -A -t -v ON_ERROR_STOP=1 -c '")).toBe(true);
    expect(cmd.endsWith("'")).toBe(true);
  });

  test("the delimiter never appears as a bare heredoc terminator line", async () => {
    const cmds: string[] = [];
    await transaction(capturingExecutor(cmds), [EVIL_STATEMENT]);
    // The word may appear as DATA inside the quoted arg, but there must be no
    // heredoc for it to terminate — the structural guarantee is "no <<".
    expect(cmds[0].includes("<<'__OPENSHIP_SQL_EOF__'")).toBe(false);
  });
});
