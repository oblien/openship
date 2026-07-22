import { describe, it, expect } from "vitest";
import {
  sq,
  injectGitToken,
  toGitHubSshUrl,
  assembleGitClone,
} from "./git-clone";

describe("sq (POSIX single-quote)", () => {
  it("wraps a plain value", () => {
    expect(sq("hello")).toBe("'hello'");
  });
  it("escapes embedded single quotes without breaking the quoting", () => {
    // a'b → 'a'\''b'  (close, escaped-quote, reopen)
    expect(sq("a'b")).toBe("'a'\\''b'");
  });
  it("neutralises shell metacharacters by quoting them", () => {
    expect(sq("$(rm -rf /)")).toBe("'$(rm -rf /)'");
  });
});

describe("injectGitToken", () => {
  it("injects x-access-token into an HTTPS URL", () => {
    expect(injectGitToken("https://github.com/owner/repo.git", "tok123")).toBe(
      "https://x-access-token:tok123@github.com/owner/repo.git",
    );
  });
  it("accepts a custom username (GitLab oauth2)", () => {
    expect(
      injectGitToken("https://gitlab.com/g/p.git", "tok123", "oauth2"),
    ).toBe("https://oauth2:tok123@gitlab.com/g/p.git");
  });
  it("returns the URL unchanged when no token", () => {
    expect(injectGitToken("https://github.com/owner/repo.git")).toBe(
      "https://github.com/owner/repo.git",
    );
  });
  it("does not touch a non-HTTPS (scp-form) URL", () => {
    expect(injectGitToken("git@github.com:owner/repo.git", "tok123")).toBe(
      "git@github.com:owner/repo.git",
    );
  });
});

describe("toGitHubSshUrl", () => {
  it("rewrites https → git@ scp form (with .git)", () => {
    expect(toGitHubSshUrl("https://github.com/owner/repo.git")).toBe(
      "git@github.com:owner/repo.git",
    );
  });
  it("appends .git when missing", () => {
    expect(toGitHubSshUrl("https://github.com/owner/repo")).toBe(
      "git@github.com:owner/repo.git",
    );
  });
  it("strips any embedded credentials", () => {
    expect(
      toGitHubSshUrl("https://x-access-token:secret@github.com/owner/repo.git"),
    ).toBe("git@github.com:owner/repo.git");
  });
});

describe("assembleGitClone — token / public mode", () => {
  const inv = assembleGitClone({
    repoUrl: "https://github.com/owner/repo.git",
    gitToken: "tok123",
  });
  it("injects the token into the clone URL", () => {
    expect(inv.cloneUrl).toBe(
      "https://x-access-token:tok123@github.com/owner/repo.git",
    );
  });
  it("fails fast instead of prompting (no interactive credential path)", () => {
    expect(inv.gitEnv).toContain("GIT_TERMINAL_PROMPT=0");
    expect(inv.gitEnv).toContain("GIT_ASKPASS=/bin/echo");
  });
  it("disables the host credential helper so the URL token is the only auth", () => {
    expect(inv.credFlag).toBe("-c credential.helper=");
  });
  it("public repo (no token) clones the plain URL", () => {
    const pub = assembleGitClone({ repoUrl: "https://github.com/owner/repo.git" });
    expect(pub.cloneUrl).toBe("https://github.com/owner/repo.git");
  });
});

describe("assembleGitClone — relay (desktop credential helper) mode", () => {
  const inv = assembleGitClone({
    repoUrl: "https://github.com/owner/repo.git",
    gitCredentialHelperPath: "/tmp/helper.sh",
  });
  it("keeps the plain URL (no token embedded)", () => {
    expect(inv.cloneUrl).toBe("https://github.com/owner/repo.git");
  });
  it("wires the remote credential helper via GIT_CONFIG_*", () => {
    expect(inv.gitEnv).toContain("GIT_CONFIG_KEY_0=credential.helper");
    expect(inv.gitEnv).toContain("GIT_CONFIG_VALUE_0='/tmp/helper.sh'");
    expect(inv.gitEnv).toContain("credential.useHttpPath");
  });
  it("does NOT disable the credential helper (it IS the auth)", () => {
    expect(inv.credFlag).toBe("");
  });
});

describe("assembleGitClone — ssh (per-server key / deploy key) mode", () => {
  const inv = assembleGitClone({
    repoUrl: "https://github.com/owner/repo.git",
    ssh: { keyFile: "/tmp/k/id_ed25519", knownHostsFile: "/tmp/k/known_hosts" },
  });
  it("clones from the git@ scp URL", () => {
    expect(inv.cloneUrl).toBe("git@github.com:owner/repo.git");
  });
  it("pins the key and known_hosts into GIT_SSH_COMMAND", () => {
    // The whole ssh command is single-quoted by sq(), so the key/hosts paths
    // are nested-escaped (…'\''…'\''…) — assert the paths + flags are present
    // rather than a specific quoting.
    expect(inv.gitEnv).toContain("GIT_SSH_COMMAND=");
    expect(inv.gitEnv).toContain("-i ");
    expect(inv.gitEnv).toContain("/tmp/k/id_ed25519");
    expect(inv.gitEnv).toContain("UserKnownHostsFile=");
    expect(inv.gitEnv).toContain("/tmp/k/known_hosts");
    expect(inv.gitEnv).toContain("IdentitiesOnly=yes");
  });
  it("uses strict host-key checking, never trust-on-first-use", () => {
    expect(inv.gitEnv).toContain("StrictHostKeyChecking=yes");
    expect(inv.gitEnv).not.toContain("accept-new");
    expect(inv.gitEnv).not.toContain("StrictHostKeyChecking=no");
  });
  it("carries no token and no private-key material in the command", () => {
    expect(inv.gitEnv).not.toContain("x-access-token");
    expect(inv.gitEnv).not.toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(inv.cloneUrl).not.toContain("x-access-token");
  });
  it("adds no credential flag", () => {
    expect(inv.credFlag).toBe("");
  });
});

describe("assembleGitClone — priority (ssh > relay > token)", () => {
  it("ssh wins even when a token and a helper are also present", () => {
    const inv = assembleGitClone({
      repoUrl: "https://github.com/owner/repo.git",
      gitToken: "tok123",
      gitCredentialHelperPath: "/tmp/helper.sh",
      ssh: { keyFile: "/tmp/k/id", knownHostsFile: "/tmp/k/kh" },
    });
    expect(inv.cloneUrl).toBe("git@github.com:owner/repo.git");
    expect(inv.gitEnv).not.toContain("tok123");
    expect(inv.gitEnv).not.toContain("credential.helper=");
  });
  it("relay wins over a token when no ssh", () => {
    const inv = assembleGitClone({
      repoUrl: "https://github.com/owner/repo.git",
      gitToken: "tok123",
      gitCredentialHelperPath: "/tmp/helper.sh",
    });
    expect(inv.cloneUrl).toBe("https://github.com/owner/repo.git");
    expect(inv.cloneUrl).not.toContain("tok123");
  });
});
