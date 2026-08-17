import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sq,
  injectGitToken,
  toGitHubSshUrl,
  assembleGitClone,
  gitCloneArgv,
  gitCloneShellPreview,
  gitTokenExtraHeader,
  httpsUrlWithoutUserinfo,
} from "./git-clone";
import { localGitSshWriter, materializeGitTokenAuth } from "./git-ssh-material";

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
  const token = "tok123";
  const inv = assembleGitClone({
    repoUrl: "https://github.com/owner/repo.git",
    gitToken: token,
  });
  it("keeps the plain URL — token is NOT in the clone URL", () => {
    expect(inv.cloneUrl).toBe("https://github.com/owner/repo.git");
    expect(inv.cloneUrl).not.toContain(token);
    expect(inv.cloneUrl).not.toContain("x-access-token");
  });
  it("puts the token in extraheader env, not argv", () => {
    expect(inv.env.GIT_CONFIG_KEY_0).toBe("http.extraHeader");
    expect(inv.env.GIT_CONFIG_VALUE_0).toBe(gitTokenExtraHeader(token));
    expect(inv.gitEnv).toContain("http.extraHeader");
    expect(gitCloneArgv(inv).join(" ")).not.toContain(token);
    expect(gitCloneArgv(inv).join(" ")).not.toContain("x-access-token");
  });
  it("disables the host credential helper so extraheader is the only auth", () => {
    expect(inv.credFlag).toBe("-c credential.helper=");
  });
  it("public repo (no token) clones the plain URL", () => {
    const pub = assembleGitClone({ repoUrl: "https://github.com/owner/repo.git" });
    expect(pub.cloneUrl).toBe("https://github.com/owner/repo.git");
  });
  it("strips a token already embedded in the URL so it cannot leak via argv", () => {
    const dirty = assembleGitClone({
      repoUrl: "https://x-access-token:preloaded@github.com/owner/repo.git",
      gitToken: token,
    });
    expect(dirty.cloneUrl).toBe("https://github.com/owner/repo.git");
    expect(gitCloneArgv(dirty).join(" ")).not.toContain("preloaded");
    expect(httpsUrlWithoutUserinfo("https://x-access-token:preloaded@github.com/o/r.git")).toBe(
      "https://github.com/o/r.git",
    );
  });
});

describe("assembleGitClone — token must not appear in process arguments", () => {
  it("never puts the token in cloneUrl, credArgs, or credFlag", () => {
    const token = "ghs_thisMustNotLeak";
    const inv = assembleGitClone({
      repoUrl: "https://github.com/owner/repo.git",
      gitToken: token,
    });
    const argv = gitCloneArgv(inv);
    expect(argv).not.toEqual(expect.arrayContaining([expect.stringContaining(token)]));
    expect(inv.cloneUrl).not.toContain(token);
    expect(inv.credFlag).not.toContain(token);
    expect(inv.credArgs.join(" ")).not.toContain(token);
    // Local spawn env map is allowed — extraheader lives there.
    expect(inv.env.GIT_CONFIG_VALUE_0).toContain(
      Buffer.from(`x-access-token:${token}`, "utf8").toString("base64"),
    );
  });

  it("remote file mode keeps the token and its base64 out of the shell command", () => {
    const token = "ghs_thisMustNotLeak";
    const b64 = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
    const inv = assembleGitClone({
      repoUrl: "https://github.com/owner/repo.git",
      gitTokenConfigFile: "/tmp/osh-gitauth/gitconfig",
    });
    const cmd = gitCloneShellPreview(inv);
    expect(cmd).toContain("GIT_CONFIG_GLOBAL=");
    expect(cmd).toContain("/tmp/osh-gitauth/gitconfig");
    expect(cmd).not.toContain(token);
    expect(cmd).not.toContain(b64);
    expect(cmd).not.toContain("x-access-token");
    expect(inv.env.GIT_CONFIG_GLOBAL).toBe("/tmp/osh-gitauth/gitconfig");
  });

  it("materializeGitTokenAuth writes extraheader to a 0600 file, not argv", async () => {
    const token = "ghs_fileOnly";
    const dir = await mkdtemp(join(tmpdir(), "osh-gitauth-"));
    const { configFile, cleanup } = await materializeGitTokenAuth(localGitSshWriter(), dir, token);
    const body = await readFile(configFile, "utf8");
    expect(body).toContain(gitTokenExtraHeader(token));
    const inv = assembleGitClone({
      repoUrl: "https://github.com/owner/repo.git",
      gitTokenConfigFile: configFile,
    });
    expect(gitCloneShellPreview(inv)).not.toContain(token);
    await cleanup();
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
    expect(() =>
      assembleGitClone({ repoUrl: "--upload-pack=touch /tmp/pwned" }),
    ).toThrow(/must not start with/);
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
