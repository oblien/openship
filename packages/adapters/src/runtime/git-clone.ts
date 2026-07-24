/**
 * @module git-clone
 *
 * The ONE place that turns a build's git credential into a clone invocation.
 * Previously this env/flag/URL assembly was copy-pasted across three sites
 * (bare pipeline, docker clone-on-server, orchestrator context). It now lives
 * here so the token / relay / ssh modes can't drift apart.
 *
 * The token and relay outputs are byte-identical to the prior inline logic;
 * `ssh` is the new mode (per-server ssh-server-key / deploy-key). File IO for
 * the SSH key + known_hosts stays at each call site (fs vs executor.writeFile
 * differ), but the COMMAND assembly is centralized here.
 */

/** POSIX single-quote a value for safe interpolation into a shell command. */
export function sq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Inject a token into an HTTPS git URL for private repo access:
 *   https://github.com/owner/repo.git → https://x-access-token:<token>@github.com/owner/repo.git
 *   https://gitlab.com/g/p.git → https://oauth2:<token>@gitlab.com/g/p.git (pass username "oauth2")
 * Unchanged when no token or the URL isn't HTTPS.
 */
export function injectGitToken(
  repoUrl: string,
  token?: string,
  username = "x-access-token",
): string {
  if (!token) return repoUrl;
  try {
    const url = new URL(repoUrl);
    if (url.protocol !== "https:") return repoUrl;
    url.username = username;
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
  /** HTTPS username for token injection. Defaults to GitHub's `x-access-token`. */
  gitTokenUsername?: string;
  gitCredentialHelperPath?: string;
  /** SSH mode — key + known_hosts files ALREADY written (0600/0700) by caller. */
  ssh?: { keyFile: string; knownHostsFile: string };
}

export interface GitCloneInvocation {
  /** URL (HTTPS) or SCP-form (git@…) to clone from. */
  cloneUrl: string;
  /** Env-var prefix for the git invocation (`FOO=bar BAZ=qux`). */
  gitEnv: string;
  /** `-c` flag placed right after `git` (empty in relay/ssh modes). */
  credFlag: string;
}

/**
 * Build the clone invocation for the given credential. Priority: ssh → relay
 * helper → token/public.
 */
export function assembleGitClone(auth: GitCloneAuth): GitCloneInvocation {
  // SSH (per-server key / deploy key): git@ URL + GIT_SSH_COMMAND pinned to the
  // provided key + known_hosts, strict host checking. No token anywhere.
  if (auth.ssh) {
    const sshCmd =
      `ssh -i ${sq(auth.ssh.keyFile)} -o IdentitiesOnly=yes ` +
      `-o StrictHostKeyChecking=yes -o UserKnownHostsFile=${sq(auth.ssh.knownHostsFile)}`;
    return {
      cloneUrl: toGitHubSshUrl(auth.repoUrl),
      gitEnv: `GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND=${sq(sshCmd)}`,
      credFlag: "",
    };
  }

  // Relay (desktop): plain URL + remote credential-helper via GIT_CONFIG_* (git
  // >=2.31, no ~/.gitconfig write). Do NOT disable credential.helper — it IS
  // the auth.
  if (auth.gitCredentialHelperPath) {
    return {
      cloneUrl: auth.repoUrl,
      gitEnv:
        `GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=2 ` +
        `GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=${sq(auth.gitCredentialHelperPath)} ` +
        `GIT_CONFIG_KEY_1=credential.useHttpPath GIT_CONFIG_VALUE_1=true`,
      credFlag: "",
    };
  }

  // Token / public: token (if any) in the URL; disable host credential helpers
  // so the URL token is the only auth (GIT_ASKPASS=/bin/echo fails fast).
  return {
    cloneUrl: injectGitToken(auth.repoUrl, auth.gitToken, auth.gitTokenUsername),
    gitEnv: "GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/echo",
    credFlag: "-c credential.helper=",
  };
}
