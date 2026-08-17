/**
 * Prove a saved GitHub credential can clone — without putting the token on argv.
 *
 * Token goes in env (`OPENSHIP_GIT_TOKEN`) and a 0700 ASKPASS script reads it.
 * Server probes reuse `probeServerGitAccess` (ls-remote on the box, stdout discarded).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { repos } from "@repo/db";
import { sshManager } from "../../lib/ssh-manager";
import { ghFetchSoft } from "./github.http";
import { probeServerGitAccess } from "./server-git-ambient";

const execFileAsync = promisify(execFile);
const CLONE_TEST_TIMEOUT_MS = 15_000;

export interface CloneAccessTestResult {
  ok: boolean;
  via: "ls-remote" | "server" | "api" | "pending" | "none";
  message: string;
  repo?: string;
}

export async function pickTestRepo(
  token: string,
  hint?: { owner?: string | null; repo?: string | null },
): Promise<string | null> {
  if (hint?.owner && hint?.repo) return `https://github.com/${hint.owner}/${hint.repo}.git`;
  const reposList = await ghFetchSoft<Array<{ full_name?: string }>>(token, {
    url: "https://api.github.com/user/repos?per_page=1&sort=updated&affiliation=owner,collaborator,organization_member",
  });
  const full = reposList?.[0]?.full_name;
  return full ? `https://github.com/${full}.git` : null;
}

/** Local `git ls-remote` authenticated via ASKPASS — token never appears in argv. */
export async function lsRemoteWithToken(repoUrl: string, token: string): Promise<boolean> {
  const dir = await mkdtemp(path.join(tmpdir(), "opsh-clonetest-"));
  const askpass = path.join(dir, "askpass.sh");
  try {
    await writeFile(
      askpass,
      "#!/bin/sh\ncase \"$1\" in *sername*|*Username*) printf '%s' 'x-access-token' ;; *) printf '%s' \"$OPENSHIP_GIT_TOKEN\" ;; esac\n",
      { encoding: "utf8" },
    );
    await chmod(askpass, 0o700);
    await execFileAsync("git", ["-c", "credential.helper=", "ls-remote", repoUrl, "HEAD"], {
      timeout: CLONE_TEST_TIMEOUT_MS,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: askpass,
        OPENSHIP_GIT_TOKEN: token,
      },
    });
    return true;
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function testTokenCloneAccess(
  token: string,
  hint?: { owner?: string | null; repo?: string | null },
): Promise<CloneAccessTestResult> {
  const repoUrl = await pickTestRepo(token, hint);
  if (!repoUrl) {
    return {
      ok: true,
      via: "api",
      message: "Token is valid, but no repository was available to test a clone.",
    };
  }
  const ok = await lsRemoteWithToken(repoUrl, token);
  const repo = repoUrl.replace(/^https:\/\/github.com\//, "").replace(/\.git$/, "");
  return ok
    ? { ok: true, via: "ls-remote", message: `Clone access verified for ${repo}.`, repo }
    : {
        ok: false,
        via: "ls-remote",
        message: `Git rejected ls-remote for ${repo}. Check token scopes (repo) and access.`,
        repo,
      };
}

export async function testServerCloneAccess(opts: {
  serverId: string;
  organizationId: string;
  repoUrl?: string | null;
  token?: string;
}): Promise<CloneAccessTestResult> {
  const projectRepo = opts.repoUrl
    ? opts.repoUrl
    : await firstProjectRepoOnServer(opts.serverId, opts.organizationId);

  if (opts.token) {
    const local = await testTokenCloneAccess(opts.token, parseGithubRepo(projectRepo));
    if (!local.ok) return local;
  }

  if (!projectRepo) {
    return opts.token
      ? {
          ok: true,
          via: "api",
          message: "Token works locally. No project repo on this server to probe from the box.",
        }
      : {
          ok: false,
          via: "none",
          message: "No repository available to test clone access on this server.",
        };
  }

  try {
    const probed = await sshManager.withExecutor(opts.serverId, async (executor) =>
      probeServerGitAccess({ executor, repoUrl: projectRepo }),
    );
    if (probed) {
      return {
        ok: true,
        via: "server",
        message: `Server can reach ${shortRepo(projectRepo)} (${probed.via}).`,
        repo: shortRepo(projectRepo),
      };
    }
  } catch (err) {
    return {
      ok: false,
      via: "server",
      message: err instanceof Error ? err.message : "Could not reach the server to test clone access.",
      repo: shortRepo(projectRepo),
    };
  }

  if (opts.token) {
    return {
      ok: true,
      via: "ls-remote",
      message: `Token can clone ${shortRepo(projectRepo)} from this host. The server itself has no ambient git access — deploys will use the stored credential.`,
      repo: shortRepo(projectRepo),
    };
  }

  return {
    ok: false,
    via: "server",
    message: `Server cannot clone ${shortRepo(projectRepo)} yet. Add the SSH key on GitHub or save a token.`,
    repo: shortRepo(projectRepo),
  };
}

async function firstProjectRepoOnServer(serverId: string, organizationId: string): Promise<string | null> {
  const listed = await repos.project.listByOrganization(organizationId, { page: 1, perPage: 50 }).catch(() => null);
  const rows = listed?.rows ?? [];
  const hit = rows.find((p) => p.serverId === serverId && p.gitOwner && p.gitRepo);
  return hit?.gitOwner && hit.gitRepo ? `https://github.com/${hit.gitOwner}/${hit.gitRepo}.git` : null;
}

function parseGithubRepo(url?: string | null): { owner?: string; repo?: string } | undefined {
  if (!url) return undefined;
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/i);
  return m ? { owner: m[1], repo: m[2] } : undefined;
}

function shortRepo(url: string): string {
  return url.replace(/^https:\/\/github.com\//, "").replace(/\.git$/, "");
}
