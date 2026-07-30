import { describe, expect, it } from "vitest";

import { escapeSystemdEnvValue } from "../src/runtime/supervisor/systemd";

// systemd's `Environment=` takes a SPACE-SEPARATED list of assignments, so an
// unquoted value is cut at its first space. Every expectation below was checked
// against real systemd (252) by starting a unit and dumping the environment the
// process actually received - the comments record that observed behaviour.

/** Render an assignment the way buildUnitFile does. */
const line = (k: string, v: string) => `Environment="${k}=${escapeSystemdEnvValue(v)}"`;

describe("escapeSystemdEnvValue", () => {
  it("leaves a simple value untouched", () => {
    expect(escapeSystemdEnvValue("3000")).toBe("3000");
    expect(line("PORT", "3000")).toBe('Environment="PORT=3000"');
  });

  it("keeps a value containing spaces in one assignment", () => {
    // Unquoted this became SITE_TITLE=My, and systemd logged
    // "Invalid environment assignment, ignoring: Cool" / ": App".
    expect(line("SITE_TITLE", "My Cool App")).toBe('Environment="SITE_TITLE=My Cool App"');
  });

  it("keeps a connection string whose tail looks like another assignment", () => {
    // The nastiest case: unquoted, systemd silently truncated DATABASE_URL at
    // `-c` AND created a stray `search_path=app` variable. No warning at all.
    const url = "postgres://u:p@h/db?options=-c search_path=app";
    expect(line("DATABASE_URL", url)).toBe(
      'Environment="DATABASE_URL=postgres://u:p@h/db?options=-c search_path=app"',
    );
  });

  it("escapes double quotes so they don't close the assignment", () => {
    // Verified: the process receives  say "hi" now
    expect(escapeSystemdEnvValue('say "hi" now')).toBe('say \\"hi\\" now');
  });

  it("escapes backslashes, and does so before the escapes it introduces", () => {
    // Verified: the process receives  C:\new\table
    // (a naive implementation that escaped quotes first would double-escape).
    expect(escapeSystemdEnvValue("C:\\new\\table")).toBe("C:\\\\new\\\\table");
    expect(escapeSystemdEnvValue('a\\"b')).toBe('a\\\\\\"b');
  });

  it("escapes % so systemd does not expand it as a specifier", () => {
    // Verified: the process receives  100% done
    expect(escapeSystemdEnvValue("100% done")).toBe("100%% done");
  });

  it("encodes newlines instead of injecting raw lines into the unit", () => {
    // A PEM key is the real-world case. Unescaped, the second line lands in the
    // [Service] section as a bogus directive and breaks daemon-reload.
    const pem = "-----BEGIN KEY-----\nabc\n-----END KEY-----";
    const escaped = escapeSystemdEnvValue(pem);

    expect(escaped).not.toContain("\n");
    expect(escaped).toBe("-----BEGIN KEY-----\\nabc\\n-----END KEY-----");
    // Verified: systemd decodes \n back to a real newline for the process.
  });

  it("encodes carriage returns and tabs", () => {
    expect(escapeSystemdEnvValue("a\tb")).toBe("a\\tb");
    expect(escapeSystemdEnvValue("a\r\nb")).toBe("a\\r\\nb");
  });

  it("never emits an unescaped quote that would terminate the assignment", () => {
    for (const value of [
      'plain "quoted" text',
      'trailing quote"',
      '"leading quote',
      'C:\\path\\"weird"',
      "%%already%%",
    ]) {
      const rendered = line("V", value);
      // Strip the escaped pairs, then nothing quote-ish may remain inside.
      const body = rendered.slice('Environment="'.length, -1).replace(/\\\\|\\"/g, "");
      expect(body).not.toContain('"');
    }
  });
});
