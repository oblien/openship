import { describe, expect, it } from "vitest";
import { redactUrlCredentials } from "./url-credentials";
import { safeErrorMessage } from "./errors";

const APP = "ghs_" + "A".repeat(36);
const PAT = "ghp_" + "B".repeat(36);

describe("redactUrlCredentials", () => {
  it("strips x-access-token userinfo from an App clone URL", () => {
    const msg = `fatal: clone of 'https://x-access-token:${APP}@github.com/Acme-Co/shared-auth.git' into submodule path '/tmp/x/lib/auth' failed`;
    const out = redactUrlCredentials(msg);
    expect(out).not.toContain(APP);
    expect(out).toContain("https://***@github.com/Acme-Co/shared-auth.git");
  });

  it("strips <token>:x-oauth-basic userinfo and bare tokens", () => {
    const out = redactUrlCredentials(`remote: https://${PAT}:x-oauth-basic@github.com/a/b.git and ${PAT}`);
    expect(out).not.toContain(PAT);
    expect(out).toBe("remote: https://***@github.com/a/b.git and ***");
  });

  it("leaves credential-free URLs, scp ssh and @ in paths alone", () => {
    const text = "https://github.com/a/b.git git@github.com:a/b.git https://x.dev/users/@me";
    expect(redactUrlCredentials(text)).toBe(text);
  });

  it("passes through empty / nullish values", () => {
    expect(redactUrlCredentials("")).toBe("");
    expect(redactUrlCredentials(null)).toBeNull();
    expect(redactUrlCredentials(undefined)).toBeUndefined();
  });

  it("stays linear on a huge line of scheme-legal characters", () => {
    const big = "a".repeat(2_000_000);
    const t0 = Date.now();
    redactUrlCredentials(big);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("safeErrorMessage", () => {
  it("redacts credentials in error messages", () => {
    const err = new Error(`git exited with code 128: fatal: unable to access 'https://x-access-token:${APP}@github.com/a/b.git/'`);
    expect(safeErrorMessage(err)).not.toContain(APP);
    expect(safeErrorMessage(`https://u:${APP}@h/x`)).toBe("https://***@h/x");
  });
});
