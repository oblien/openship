import { describe, expect, it } from "vitest";
import {
  gitmodulesTextFromContentsBody,
  installationTokenRepositories,
  MAX_SUBMODULE_REPOS,
  parseSameOwnerSubmoduleRepos,
} from "./gitmodules";

const OWNER = "Acme-Co";

const APP_GITMODULES = `[submodule "lib/auth"]
\tpath = lib/auth
\turl = ../shared-auth.git
[submodule "lib/ui"]
\tpath = lib/ui
\turl = https://github.com/Acme-Co/shared-ui.git
[submodule "vendor/other-owner"]
\tpath = vendor/other-owner
\turl = https://github.com/someone-else/lib.git
[submodule "vendor/gitlab"]
\tpath = vendor/gitlab
\turl = https://gitlab.com/Acme-Co/mirror.git
[submodule "lib/ssh"]
\tpath = lib/ssh
\turl = git@github.com:Acme-Co/shared-ssh.git
`;

describe("parseSameOwnerSubmoduleRepos", () => {
  it("keeps same-owner relative, https and ssh submodules; drops other owners and hosts", () => {
    expect(parseSameOwnerSubmoduleRepos(APP_GITMODULES, OWNER, "webapp")).toEqual([
      "shared-auth",
      "shared-ui",
      "shared-ssh",
    ]);
  });

  it("resolves ../ relative URLs against the parent, case-insensitively on owner", () => {
    const text = `[submodule "a"]\n  url = ../shared-auth.git\n`;
    expect(parseSameOwnerSubmoduleRepos(text, "acme-co", "Billing")).toEqual([
      "shared-auth",
    ]);
  });

  it("ignores ./ (nested path under the parent), the parent itself, and ../../ escapes", () => {
    const text = [
      "url = ./nested.git",
      "url = ../billing.git",
      "url = ../../evil-owner/x.git",
    ].join("\n");
    expect(parseSameOwnerSubmoduleRepos(text, OWNER, "billing")).toEqual([]);
  });

  it("de-duplicates and ignores comments and unparseable lines", () => {
    const text = [
      "# url = ../commented.git",
      "; url = ../commented2.git",
      "url = ../shared-auth.git",
      "url = https://github.com/Acme-Co/Shared-Auth",
      "url = not a url",
      "url =",
      "url = ssh://git@github.com/Acme-Co/shared-ssh.git",
      "url = https://github.com/Acme-Co/repo/extra/path.git",
    ].join("\n");
    expect(parseSameOwnerSubmoduleRepos(text, OWNER, "webapp")).toEqual(["shared-auth", "shared-ssh"]);
  });

  it("does not leak credentials or accept userinfo-bearing foreign hosts", () => {
    const text = "url = https://user:pw@evil.example.com/Acme-Co/x.git";
    expect(parseSameOwnerSubmoduleRepos(text, OWNER, "webapp")).toEqual([]);
  });

  it("honours a GitHub Enterprise host for absolute URLs", () => {
    const text = [
      "url = https://ghe.example.com/acme/lib.git",
      "url = https://github.com/acme/public.git",
      "url = ../rel.git",
    ].join("\n");
    expect(parseSameOwnerSubmoduleRepos(text, "acme", "app", "ghe.example.com")).toEqual(["lib", "rel"]);
  });
});

describe("gitmodulesTextFromContentsBody", () => {
  it("decodes the Contents API base64 envelope", () => {
    const raw = "[submodule \"a\"]\n\turl = ../shared-auth.git\n";
    const b64 = Buffer.from(raw).toString("base64");
    const body = JSON.stringify({ encoding: "base64", content: b64.match(/.{1,20}/g)!.join("\n") });
    expect(gitmodulesTextFromContentsBody(body)).toBe(raw);
  });

  it("passes raw text through", () => {
    expect(gitmodulesTextFromContentsBody("url = ../x.git")).toBe("url = ../x.git");
  });
});

describe("installationTokenRepositories", () => {
  it("keeps upstream's exact [repo] narrowing when there are no extras", () => {
    expect(installationTokenRepositories("billing", undefined)).toEqual(["billing"]);
    expect(installationTokenRepositories("billing", [])).toEqual(["billing"]);
    expect(installationTokenRepositories(undefined, undefined)).toBeUndefined();
  });

  it("puts the parent first and de-duplicates case-insensitively", () => {
    expect(installationTokenRepositories("Webapp", ["shared-auth", "webapp", " Shared-Auth ", ""])).toEqual([
      "Webapp",
      "shared-auth",
    ]);
  });

  it("caps the list at parent + MAX_SUBMODULE_REPOS", () => {
    const many = Array.from({ length: 100 }, (_, i) => `r${i}`);
    const out = installationTokenRepositories("parent", many)!;
    expect(out).toHaveLength(MAX_SUBMODULE_REPOS + 1);
    expect(out[0]).toBe("parent");
  });
});
