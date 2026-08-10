/**
 * @module git-clone
 *
 * The ONE place that turns a build's git credential into a clone invocation.
 * Previously this env/flag/URL assembly was copy-pasted across three sites
 * (bare pipeline, docker clone-on-server, orchestrator context). It now lives
 * here so the token / relay / ssh / ambient modes can't drift apart.
 *
 * Every mode is emitted in two equivalent shapes so both call styles share this
 * one definition: `gitEnv`/`credFlag` for shell-string invocations (remote
 * `exec`) and `env`/`credArgs` for argv invocations (local `spawn`). File IO for
 * the SSH key + known_hosts lives in `git-ssh-material.ts` (the IO backend
 * differs per site; the layout does not).
 */

import type { AmbientGitVia } from "../types";

export type { AmbientGitVia };

/** POSIX single-quote a value for safe interpolation into a shell command. */
export function sq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Inject a token into an HTTPS git URL for private repo access:
 *   https://github.com/owner/repo.git → https://x-access-token:<token>@github.com/owner/repo.git
 * Unchanged when no token or the URL isn't HTTPS.
 */
export function injectGitToken(repoUrl: string, token?: string): string {
  if (!token) return repoUrl;
  try {
    const url = new URL(repoUrl);
    if (url.protocol !== "https:") return repoUrl;
    url.username = "x-access-token";
    url.password = token;
    return url.toString();
  } catch {
    return repoUrl;
  }
}

/**
 * Rewrite an HTTPS repo URL to its SSH SCP form for git@ cloning:
 *   https://github.com/owner/repo(.git) → git@github.com:owner/repo.git
 * Strips any embedded credentials. Returns the input unchanged if unparseable.
 */
export function toGitHubSshUrl(repoUrl: string): string {
  try {
    const url = new URL(repoUrl);
    const host = url.hostname;
    const repoPath = url.pathname.replace(/^\/+/, "").replace(/\.git$/, "");
    return `git@${host}:${repoPath}.git`;
  } catch {
    return repoUrl;
  }
}

export interface GitCloneAuth {
  repoUrl: string;
  gitToken?: string;
  gitCredentialHelperPath?: string;
  /** SSH mode — key + known_hosts files ALREADY written (0600/0700) by caller. */
  ssh?: { keyFile: string; knownHostsFile: string };
  /**
   * Ambient mode: clone using the credentials ALREADY on the host running the
   * clone. Valid only for a clone that runs on the machine whose credentials
   * these are — never for an orchestrator clone standing in for a server.
   */
  ambient?: { via: AmbientGitVia };
}

export interface GitCloneInvocation {
  /** URL (HTTPS) or SCP-form (git@…) to clone from. */
  cloneUrl: string;
  /** Env-var prefix for a shell-string git invocation (`FOO=bar BAZ=qux`). */
  gitEnv: string;
  /** `-c` flag string placed right after `git` (empty in relay/ssh/ambient modes). */
  credFlag: string;
  /** Same env as `gitEnv`, for callers that pass an env map to spawn(). */
  env: Record<string, string>;
  /** Same flag as `credFlag`, pre-split for argv callers (empty array when none). */
  credArgs: string[];
}

/** One env entry: name, value, and whether the shell form needs quoting. */
type EnvEntry = [name: string, value: string, quote: boolean];

const TERMINAL_PROMPT: EnvEntry = ["GIT_TERMINAL_PROMPT", "0", false];

function invocation(
  cloneUrl: string,
  entries: EnvEntry[],
  disableHelper: boolean,
): GitCloneInvocation {
  return {
    cloneUrl,
    gitEnv: entries.map(([k, v, q]) => `${k}=${q ? sq(v) : v}`).join(" "),
    credFlag: disableHelper ? "-c credential.helper=" : "",
    env: Object.fromEntries(entries.map(([k, v]) => [k, v])),
    credArgs: disableHelper ? ["-c", "credential.helper="] : [],
  };
}

/**
 * Reject a repo URL that git would parse as an OPTION rather than a remote.
 *
 * Shell quoting (`sq`) makes the URL one shell word but says nothing about how
 * git reads it: `git clone '--upload-pack=…' dir` still parses as a flag, which
 * turns a repo URL into arbitrary command execution on the build host. Every
 * clone site passes the URL positionally, so the check belongs here, at the one
 * place they all go through. No legitimate remote begins with `-`, so this can
 * only fire on a malformed or hostile value.
 */
function assertNotOptionLike(repoUrl: string): void {
  if (repoUrl.trimStart().startsWith("-")) {
    throw new Error(
      `Refusing to clone from ${JSON.stringify(repoUrl)}: a repository URL must not start with "-" (git would read it as an option).`,
    );
  }
}

/**
 * Build the clone invocation for the given credential.
 * Priority: ssh → relay helper → ambient → token/public.
 */
export function assembleGitClone(auth: GitCloneAuth): GitCloneInvocation {
  assertNotOptionLike(auth.repoUrl);

  // SSH (per-server key / deploy key): git@ URL + GIT_SSH_COMMAND pinned to the
  // provided key + known_hosts, strict host checking. No token anywhere.
  if (auth.ssh) {
    const sshCmd =
      `ssh -i ${sq(auth.ssh.keyFile)} -o IdentitiesOnly=yes ` +
      `-o StrictHostKeyChecking=yes -o UserKnownHostsFile=${sq(auth.ssh.knownHostsFile)}`;
    return invocation(
      toGitHubSshUrl(auth.repoUrl),
      [TERMINAL_PROMPT, ["GIT_SSH_COMMAND", sshCmd, true]],
      false,
    );
  }

  // Relay (desktop): plain URL + remote credential-helper via GIT_CONFIG_* (git
  // >=2.31, no ~/.gitconfig write). Do NOT disable credential.helper — it IS
  // the auth.
  if (auth.gitCredentialHelperPath) {
    return invocation(
      auth.repoUrl,
      [
        TERMINAL_PROMPT,
        ["GIT_CONFIG_COUNT", "2", false],
        ["GIT_CONFIG_KEY_0", "credential.helper", false],
        ["GIT_CONFIG_VALUE_0", auth.gitCredentialHelperPath, true],
        ["GIT_CONFIG_KEY_1", "credential.useHttpPath", false],
        ["GIT_CONFIG_VALUE_1", "true", false],
      ],
      false,
    );
  }

  // Ambient: the host's own credentials are the auth, so we must NOT disable its
  // credential helper (the opposite of token mode) and no secret is supplied.
  if (auth.ambient) {
    if (auth.ambient.via === "ssh") {
      return invocation(toGitHubSshUrl(auth.repoUrl), [TERMINAL_PROMPT], false);
    }
    if (auth.ambient.via === "gh") {
      return invocation(
        auth.repoUrl,
        [
          TERMINAL_PROMPT,
          ["GIT_CONFIG_COUNT", "1", false],
          ["GIT_CONFIG_KEY_0", "credential.helper", false],
          ["GIT_CONFIG_VALUE_0", "!gh auth git-credential", true],
        ],
        false,
      );
    }
    // "helper": whatever the host already has configured.
    return invocation(auth.repoUrl, [TERMINAL_PROMPT], false);
  }

  // Token / public: token (if any) in the URL; disable host credential helpers
  // so the URL token is the only auth (GIT_ASKPASS=/bin/echo fails fast).
  return invocation(
    injectGitToken(auth.repoUrl, auth.gitToken),
    [TERMINAL_PROMPT, ["GIT_ASKPASS", "/bin/echo", false]],
    true,
  );
}
