import { describe, it, expect } from "vitest";
import {
  sq,
  injectGitToken,
  gitCredentialPair,
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
  it("injects x-access-token for a GitHub App installation token (ghs_…)", () => {
    expect(injectGitToken("https://github.com/owner/repo.git", "ghs_1234")).toBe(
      "https://x-access-token:ghs_1234@github.com/owner/repo.git",
    );
  });
  it("rides a classic PAT in the username slot on github.com", () => {
    expect(injectGitToken("https://github.com/owner/repo.git", "ghp_1234")).toBe(
      "https://ghp_1234:x-oauth-basic@github.com/owner/repo.git",
    );
  });
  it("rides a fine-grained PAT in the username slot on github.com", () => {
    expect(injectGitToken("https://github.com/owner/repo.git", "github_pat_1234")).toBe(
      "https://github_pat_1234:x-oauth-basic@github.com/owner/repo.git",
    );
  });
  it("rides an OAuth token in the username slot on github.com", () => {
    expect(injectGitToken("https://github.com/owner/repo.git", "gho_1234")).toBe(
      "https://gho_1234:x-oauth-basic@github.com/owner/repo.git",
    );
  });
  it("treats a legacy prefix-less PAT as a user token", () => {
    const legacy = "a".repeat(40);
    expect(injectGitToken("https://github.com/owner/repo.git", legacy)).toBe(
      `https://${legacy}:x-oauth-basic@github.com/owner/repo.git`,
    );
  });
  it("keeps x-access-token on non-GitHub hosts (arbitrary username accepted)", () => {
    expect(injectGitToken("https://gitlab.com/owner/repo.git", "glpat-1")).toBe(
      "https://x-access-token:glpat-1@gitlab.com/owner/repo.git",
    );
  });
  it("keeps x-access-token on GitHub Enterprise (own domain, not github.com)", () => {
    expect(injectGitToken("https://github.acme-corp.com/owner/repo.git", "ghp_1234")).toBe(
      "https://x-access-token:ghp_1234@github.acme-corp.com/owner/repo.git",
    );
  });
  it("trims a pasted token instead of percent-encoding the whitespace", () => {
    expect(injectGitToken("https://github.com/owner/repo.git", "  ghp_1234\n")).toBe(
      "https://ghp_1234:x-oauth-basic@github.com/owner/repo.git",
    );
  });
  it("returns the URL unchanged when the token is only whitespace", () => {
    expect(injectGitToken("https://github.com/owner/repo.git", "   ")).toBe(
      "https://github.com/owner/repo.git",
    );
  });
  it("returns the URL unchanged when no token", () => {
    expect(injectGitToken("https://github.com/owner/repo.git")).toBe(
      "https://github.com/owner/repo.git",
    );
  });
  it("does not touch a non-HTTPS (scp-form) URL", () => {
    expect(injectGitToken("git@github.com:owner/repo.git", "ghp_1234")).toBe(
      "git@github.com:owner/repo.git",
    );
  });

  // A URL missing the password is not a complete credential: git sends an empty
  // password, then on the 401 asks GIT_ASKPASS / the credential helper / the tty
  // for the real one. Every clone path sets GIT_ASKPASS=/bin/echo, so a path that
  // forgets it dies with "unable to get password from user" and never surfaces
  // GitHub's reason. Both slots filled = self-contained on success and failure.
  it("always emits BOTH Basic-auth slots, whatever the token or host", () => {
    const tokens = ["ghs_1", "ghp_1", "github_pat_1", "gho_1", "ghu_1", "a".repeat(40), "glpat-1"];
    const hosts = ["github.com", "github.acme-corp.com", "gitlab.com", "git.example.org"];
    for (const host of hosts) {
      for (const token of tokens) {
        const out = injectGitToken(`https://${host}/owner/repo.git`, token);
        const { username, password } = new URL(out);
        expect(username, `${host} / ${token}`).not.toBe("");
        expect(password, `${host} / ${token}`).not.toBe("");
        expect(out).toContain(`@${host}/`);
      }
    }
  });
});

describe("gitCredentialPair", () => {
  it("carries the token in exactly one slot and a fixed literal in the other", () => {
    const user = gitCredentialPair("github.com", "ghp_1234");
    expect(user).toEqual({ username: "ghp_1234", password: "x-oauth-basic" });
    const app = gitCredentialPair("github.com", "ghs_1234");
    expect(app).toEqual({ username: "x-access-token", password: "ghs_1234" });
  });
  // Suffix-matching the host would pull gist./raw. subdomains into the github.com
  // branch. Neither is a clone source, and the general form works on both, so the
  // test is an exact host match on purpose.
  it("matches github.com exactly — subdomains take the general form", () => {
    expect(gitCredentialPair("gist.github.com", "ghp_1234")).toEqual({
      username: "x-access-token",
      password: "ghp_1234",
    });
  });
});

describe("toGitHubSshUrl", () => {
  it("rewrites https → git@ scp form (with .git)", () => {
    expect(toGitHubSshUrl("https://github.com/owner/repo.git")).toBe(
      "git@github.com:owner/repo.git",
    );
  });
  it("appends .git when missing", () => {
    expect(toGitHubSshUrl("https://github.com/owner/repo")).toBe("git@github.com:owner/repo.git");
  });
  it("strips any embedded credentials", () => {
    expect(toGitHubSshUrl("https://x-access-token:secret@github.com/owner/repo.git")).toBe(
      "git@github.com:owner/repo.git",
    );
  });
});

describe("assembleGitClone — token / public mode", () => {
  const inv = assembleGitClone({
    repoUrl: "https://github.com/owner/repo.git",
    gitToken: "ghp_1234",
  });
  it("injects the token into the clone URL (PAT as username on github.com)", () => {
    expect(inv.cloneUrl).toBe("https://ghp_1234:x-oauth-basic@github.com/owner/repo.git");
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

describe("assembleGitClone — option-injection guard", () => {
  // sq() makes the URL one shell WORD; it does not stop git from parsing a
  // leading dash as a flag. `--upload-pack=` would be RCE on the build host.
  it("refuses a URL that git would read as an option", () => {
    expect(() => assembleGitClone({ repoUrl: "--upload-pack=touch /tmp/pwned" })).toThrow(
      /must not start with/,
    );
  });
  it("refuses it regardless of leading whitespace", () => {
    expect(() => assembleGitClone({ repoUrl: "  --config=core.sshCommand=id" })).toThrow(
      /must not start with/,
    );
  });
  it("refuses it in ssh mode too (the rewrite must not launder it)", () => {
    expect(() =>
      assembleGitClone({
        repoUrl: "-oProxyCommand=id",
        ssh: { keyFile: "/tmp/k/id", knownHostsFile: "/tmp/k/kh" },
      }),
    ).toThrow(/must not start with/);
  });
  it("allows ordinary https and scp-form remotes", () => {
    expect(() => assembleGitClone({ repoUrl: "https://github.com/owner/repo.git" })).not.toThrow();
    expect(() => assembleGitClone({ repoUrl: "git@github.com:owner/repo.git" })).not.toThrow();
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
