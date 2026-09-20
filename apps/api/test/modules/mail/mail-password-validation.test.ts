/**
 * Boundary validation for operator-supplied mail passwords
 * (GHSA-x2xg-5h5f-j5m9, second-order sink).
 *
 * The advisory's original chain — `export K='V'` written to
 * /root/iRedMail-engine/config, then SOURCED as root by `iRedMail.sh` — is gone
 * with the containerized engine. But `config.adminPassword` on POST /mail/setup
 * is still a bare cast off the request body, and it still travels to the box
 * verbatim: now as one record in the engine's line-delimited `--env-file`.
 *
 * A control character there ends the record, so the remainder becomes additional
 * environment entries for a container running `--network host --cap-add
 * NET_ADMIN` with host bind mounts. `writeEnvFile` (packages/adapters) rejects
 * that structurally; this is the boundary layer, so the caller gets a 400 instead
 * of a step failure mid-SSE-stream.
 *
 * The same value is persisted into mail-state and replayed on the next container
 * bring-up, which is why the postmaster-rotation endpoint shares this check.
 */

import "./_setup-env"; // MUST be first — sets INTERNAL_TOKEN before config/env loads
import { describe, expect, it } from "vitest";
import { mailPasswordError } from "../../../src/modules/mail/mail.controller";

describe("mailPasswordError", () => {
  it("accepts a normal strong password", () => {
    expect(mailPasswordError("correct horse battery")).toBeNull();
  });

  it("accepts shell metacharacters — nothing shell-parses this value any more", () => {
    // Deliberate: the original advisory's payload shape must NOT be rejected as
    // if it were still dangerous. Over-restricting the charset would break real
    // generated passwords; only the record shape matters.
    expect(mailPasswordError(`a'b"c$(id)\`x\`;rm -rf /`)).toBeNull();
  });

  it("rejects the newline that injects a second env-file record", () => {
    expect(mailPasswordError("aaaaaaaaaaaa\nBASH_FUNC_psql%%=() { echo pwned; }")).toMatch(
      /single line/i,
    );
  });

  it("rejects a bare carriage return", () => {
    expect(mailPasswordError("aaaaaaaaaaaa\rFIRST_DOMAIN=evil.tld")).toMatch(/single line/i);
  });

  it("rejects other control characters (NUL, tab, DEL)", () => {
    for (const ch of ["\u0000", "\t", "\u007f"]) {
      expect(mailPasswordError(`aaaaaaaaaaaa${ch}x`), JSON.stringify(ch)).toMatch(
        /single line/i,
      );
    }
  });

  it("enforces length bounds", () => {
    expect(mailPasswordError("short")).toMatch(/at least 12/);
    expect(mailPasswordError("a".repeat(129))).toMatch(/at most 128/);
    expect(mailPasswordError("a".repeat(128))).toBeNull();
  });

  it("labels the field so the setup path reports a human-readable name", () => {
    // POST /mail/setup passes "Admin password" so the surfaced 400 reads cleanly
    // ("Admin password must be at least 12 characters"), not the internal path.
    expect(mailPasswordError("short", "Admin password")).toMatch(/^Admin password/);
  });
});
