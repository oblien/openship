/**
 * @module git-clone
 *
 * The ONE place that turns a build's git credential into a clone invocation.
 * Previously this env/flag/URL assembly was copy-pasted across three sites
 * (bare pipeline, docker clone-on-server, orchestrator context). It now lives
 * here so the token / relay / ssh / ambient modes can't drift apart.
 *
 * Every mode emits both shell (`gitEnv`/`credFlag`) and argv
 * (`env`/`credArgs`) shapes. Relay mode additionally carries a shell-only
 * pre-authentication step; relay credentials are only used by remote shell
 * clones. File IO for the SSH key + known_hosts lives in
 * `git-ssh-material.ts` (the IO backend differs per site; the layout does not).
 */

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import type { AmbientGitVia } from "../types";
import { shellQuote } from "@repo/core";

export type { AmbientGitVia };

// Initialize only after selecting the parent commit. --checkout honors the
// recorded gitlink instead of following a submodule branch or merge strategy.
export const GIT_SUBMODULE_UPDATE_ARGS = [
  "submodule",
  "update",
  "--init",
  "--recursive",
  "--checkout",
  "--depth",
  "1",
  "--progress",
] as const;

/** Alias of `@repo/core`'s {@link shellQuote}. Kept as a name because ~300 call sites in
 *  this package read `sq(...)`; there is one implementation, in core. */
export const sq = shellQuote;

/**
 * The Basic-auth pair for a git HTTPS credential.
 *
 * Both slots are ALWAYS filled. `https://<token>@host` is not a complete
 * credential to git: it sends an empty password, and on the 401 goes looking for
 * the real one — GIT_ASKPASS, then the credential helper, then the tty. Legacy
 * URL-token paths set `GIT_ASKPASS=/bin/echo`, so that detour ends in a
 * retry with garbage; a path that forgets to set it fails with git's "unable to
 * get password from user" before it ever authenticates, hiding GitHub's actual
 * reason. Filling both slots keeps the URL self-contained on success AND failure.
 *
 * Which slot holds the token does not matter to GitHub — it reads the token from
 * either and ignores the other value. So each token type gets the pair GitHub
 * itself documents: `x-access-token:<token>` for App installation tokens,
 * `<token>:x-oauth-basic` for user tokens (PAT classic, fine-grained, OAuth).
 */
export function gitCredentialPair(
  hostname: string,
  token: string,
): { username: string; password: string } {
  // Exact host, not a suffix match. Every other host — GitHub Enterprise on its
  // own domain, GitLab, Gitea — takes the x-access-token form, which works
  // wherever an arbitrary username is accepted. Narrowing this test can only
  // route a host to the general form, never strand one without a credential.
  if (hostname === "github.com" && !token.startsWith("ghs_")) {
    return { username: token, password: "x-oauth-basic" };
  }
  return { username: "x-access-token", password: token };
}

/**
 * Inject a token into an HTTPS git URL for private repo access:
 *   https://github.com/owner/repo.git
 *     → https://<token>:x-oauth-basic@github.com/owner/repo.git
 * Unchanged when there is no token or the URL isn't HTTPS.
 */
export function injectGitToken(repoUrl: string, token?: string): string {
  // Trim first: a token pasted with surrounding whitespace percent-encodes into
  // the URL (%20…%20) and fails auth for a reason no log makes visible.
  const secret = token?.trim();
  if (!secret) return repoUrl;
  try {
    const url = new URL(repoUrl);
    if (url.protocol !== "https:") return repoUrl;
    const { username, password } = gitCredentialPair(url.hostname, secret);
    url.username = username;
    url.password = password;
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
  /** Exact repository grant for App tokens; otherwise use the URL's namespace. */
  gitTokenRepositories?: string[];
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
  /** Static counterpart of `gitEnv` for callers that pass an env map to spawn(). */
  env: Record<string, string>;
  /** Same flag as `credFlag`, pre-split for argv callers (empty array when none). */
  credArgs: string[];
  /**
   * Shell-only setup which must run immediately before a networked git command.
   *
   * The desktop relay uses this to fetch a short-lived Authorization header
   * through its tunnel before Git's first HTTP request. Git otherwise starts a
   * public-repository clone anonymously and only consults credential helpers
   * after a 401 challenge; GitHub's anonymous-download throttle is a terminal
   * response, not a challenge, so the helper would never be called.
   */
  shellPrelude?: string;
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

// Only Git invokes this deployment-scoped helper. No secret is embedded in the
// helper, repository config or a file; it reads the per-command environment.
// useHttpPath prevents Git from reusing a parent credential for another repo.
const SCOPED_TOKEN_HELPER = `!f() {
  [ "$1" = get ] || return 0
  protocol= host= path=
  while IFS= read -r line; do
    case "$line" in
      protocol=*) protocol=\${line#protocol=} ;;
      host=*) host=\${line#host=} ;;
      path=*) path=\${line#path=} ;;
    esac
  done
  [ "$protocol" = https ] || return 0
  host=$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')
  [ "$host" = "$OPENSHIP_GIT_HOST" ] || return 0
  path=$(printf '%s' "$path" | tr '[:upper:]' '[:lower:]')
  path=\${path%/}
  path=\${path%.git}
  case "$path" in ""|*[!a-z0-9_./-]*) return 0 ;; esac
  case "$path" in "$OPENSHIP_GIT_NAMESPACE/"*) repo=\${path#"$OPENSHIP_GIT_NAMESPACE/"} ;; *) return 0 ;; esac
  case "$repo" in ""|.|..|*/*) return 0 ;; esac
  if [ -n "$OPENSHIP_GIT_REPOSITORIES" ]; then
    case " $OPENSHIP_GIT_REPOSITORIES " in *" $path "*) ;; *) return 0 ;; esac
  fi
  printf 'username=%s\\npassword=%s\\n' "$OPENSHIP_GIT_USERNAME" "$OPENSHIP_GIT_PASSWORD"
}; f`;

function scopedTokenInvocation(auth: GitCloneAuth): GitCloneInvocation {
  const url = new URL(auth.repoUrl);
  const segments = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  const parent = segments.pop();
  const namespace = segments.join("/").toLowerCase();
  const name = /^[A-Za-z0-9_.-]{1,100}$/;
  const validName = (value: string) => name.test(value) && value !== "." && value !== "..";
  const repositories = auth.gitTokenRepositories;
  if (
    url.protocol !== "https:" ||
    !namespace ||
    !parent ||
    !segments.every(validName) ||
    !validName(parent.replace(/\.git$/i, "")) ||
    (repositories !== undefined &&
      (!repositories.length || repositories.length > 26 || !repositories.every(validName)))
  )
    throw new Error(
      "Scoped clone credentials require an HTTPS repository URL and valid repository grants.",
    );
  const allowed = repositories && [...new Set(repositories.map((repo) => repo.toLowerCase()))];
  if (allowed && !allowed.includes(parent.replace(/\.git$/i, "").toLowerCase()))
    throw new Error("The clone grant does not include the parent repository.");
  url.username = "";
  url.password = "";
  const pair = gitCredentialPair(url.hostname, auth.gitToken!.trim());
  const base = `https://${url.host}/`;
  const settings = [
    ["credential.helper", ""],
    ["credential.helper", SCOPED_TOKEN_HELPER],
    ["credential.useHttpPath", "true"],
    ["protocol.allow", "never"],
    ["protocol.https.allow", "always"],
    // A redirected clone must not carry credentials to another origin/path.
    ["http.followRedirects", "false"],
    // Transport rewrites contain no secret. Private SSH submodules can use the
    // credential only after becoming HTTPS requests inside its scope.
    [`url.${base}.insteadOf`, `git@${url.hostname}:`],
    [`url.${base}.insteadOf`, `ssh://git@${url.hostname}/`],
    [`url.${base}.insteadOf`, `ssh://${url.hostname}/`],
  ];
  const baseInvocation = invocation(
    url.href,
    [
      TERMINAL_PROMPT,
      ["GIT_ASKPASS", "/bin/false", false],
      // Also override per-protocol ambient host allowances. Approved SSH URLs
      // are rewritten to HTTPS before Git applies this transport policy.
      ["GIT_ALLOW_PROTOCOL", "https", false],
      ["OPENSHIP_GIT_HOST", url.host.toLowerCase(), true],
      ["OPENSHIP_GIT_NAMESPACE", namespace, true],
      [
        "OPENSHIP_GIT_REPOSITORIES",
        allowed?.map((repo) => `${namespace}/${repo}`).join(" ") ?? "",
        true,
      ],
      ["OPENSHIP_GIT_USERNAME", pair.username, true],
      ["OPENSHIP_GIT_PASSWORD", pair.password, true],
    ],
    false,
  );
  // Git propagates -c configuration to submodule children. This avoids raising
  // the minimum Git version for server builds (GIT_CONFIG_COUNT needs 2.31).
  const credArgs = settings.flatMap(([key, value]) => ["-c", `${key}=${value}`]);
  return { ...baseInvocation, credArgs, credFlag: credArgs.map(sq).join(" ") };
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
    const base = invocation(
      auth.repoUrl,
      [
        TERMINAL_PROMPT,
        // An empty helper value resets helpers inherited from the host before
        // adding the deployment-scoped relay. Without the reset, a server's
        // stale/global helper can answer first and silently override the
        // forwarded identity named in the deployment log.
        ["GIT_CONFIG_COUNT", "3", false],
        ["GIT_CONFIG_KEY_0", "credential.helper", false],
        ["GIT_CONFIG_VALUE_0", "", true],
        ["GIT_CONFIG_KEY_1", "credential.helper", false],
        ["GIT_CONFIG_VALUE_1", auth.gitCredentialHelperPath, true],
        ["GIT_CONFIG_KEY_2", "credential.useHttpPath", false],
        ["GIT_CONFIG_VALUE_2", "true", false],
      ],
      false,
    );

    let url: URL;
    try {
      url = new URL(auth.repoUrl);
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "adapters/runtime/git-clone");
      throw new Error("Git credential forwarding requires an absolute HTTPS repository URL");
    }
    if (url.protocol !== "https:") {
      throw new Error("Git credential forwarding requires an HTTPS repository URL");
    }
    const protocol = url.protocol.slice(0, -1);
    const path = url.pathname.replace(/^\/+/, "");
    const headerUrl = new URL(url);
    headerUrl.username = "";
    headerUrl.password = "";
    headerUrl.search = "";
    headerUrl.hash = "";
    const headerVar = "OPENSHIP_GIT_AUTH_HEADER";
    const headerCommand =
      `${sq(auth.gitCredentialHelperPath)} auth-header ` +
      `${sq(protocol)} ${sq(url.hostname)} ${sq(path)}`;

    return {
      ...base,
      // `auth-header` returns only the Basic header, never prints it to the
      // build log, and keeps the token out of the command text and filesystem.
      // The value exists only in the remote shell/git process for this command.
      shellPrelude: `${headerVar}="$(${headerCommand})" && ` + `test -n "$${headerVar}"`,
      // The argv representation above remains a valid challenge-based helper
      // invocation for local spawn users. Remote shell users call
      // gitShellCommand(), which adds the preemptive header as config slot 3.
      gitEnv:
        `${base.gitEnv.replace("GIT_CONFIG_COUNT=3", "GIT_CONFIG_COUNT=4")} ` +
        // A submodule may name another host/repository. Its authentication must
        // go through the scoped relay helper, never inherit the parent's header.
        `GIT_CONFIG_KEY_3=${sq(`http.${headerUrl.href}.extraHeader`)} GIT_CONFIG_VALUE_3="$${headerVar}"`,
    };
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

  // One helper for parent and recursive submodule clones. App grants stay exact;
  // user tokens retain their GitHub permissions within the same host/namespace.
  // Tokens never live in origin URLs or host-wide credential configuration.
  if (
    auth.gitToken?.trim() &&
    (auth.gitTokenRepositories !== undefined || /^https:\/\//i.test(auth.repoUrl.trimStart()))
  )
    return scopedTokenInvocation(auth);
  return invocation(
    injectGitToken(auth.repoUrl, auth.gitToken),
    [TERMINAL_PROMPT, ["GIT_ASKPASS", "/bin/echo", false]],
    true,
  );
}

/**
 * Render one networked git command for a shell executor.
 *
 * Keep this centralized: relay mode has a security-sensitive prelude which
 * obtains an in-memory Authorization header. Hand-assembling `gitEnv + git` at
 * a call site would silently fall back to an anonymous first request.
 */
export function gitShellCommand(invocation: GitCloneInvocation, args: string): string {
  const env = invocation.gitEnv ? `${invocation.gitEnv} ` : "";
  const flags = invocation.credFlag ? `${invocation.credFlag} ` : "";
  const command = `${env}git ${flags}${args}`;
  return invocation.shellPrelude ? `${invocation.shellPrelude} && ${command}` : command;
}
