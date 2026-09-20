# Git credential forwarding (desktop-only)

Lets a **server build clone on a remote server using the operator's LOCAL `gh` identity** — so you
don't have to use the Openship Cloud GitHub App token _and_ don't have to build locally then upload —
**without persisting any credential on the remote**. One consumer:

| Consumer       | Entry point                                    | Use                                                                                    |
| -------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Deployment** | `openDeployRelay()` ([deploy.ts](./deploy.ts)) | Clone on a self-hosted server during a server build, repo-pinned to the deploy's repo. |

It is **point-of-use, off by default**: there is **no persistent server flag**. The operator opts in
**per deploy** via the "Forward my git credentials" checkbox in the deploy flow's target step; the
choice is persisted into the deployment's config snapshot. The build pipeline re-checks **desktop mode**
server-side before opening a relay (never trust a client-sent flag on a non-desktop host), and the
`gh`-token path self-disables under `CLOUD_MODE`.

> The interactive **terminal** does _not_ forward credentials. It was intentionally dropped: a terminal
> is interactive (arbitrary repos → can't be repo-pinned) with a longer live window, making it the one
> path that would vend creds for _any_ repo. Concentrating on the deploy path — repo known up front,
> window = build duration — gives one tight, well-scoped path. SSH-protocol git (`git@github.com`) is
> not covered either (that needs connection-level SSH-agent forwarding); deploys clone over HTTPS.

## How it works — HTTPS credential relay (`https://github.com`, the `gh` token)

On-demand, never-persisted. Flow:

1. **Reverse tunnel** — `reverseForward` asks the remote to listen on an ephemeral `127.0.0.1` port
   and pipe each connection back to this process over the existing SSH connection.
2. **Helper script** — `writeHelperScript` ([relay.ts](./relay.ts)) drops a `0700` bash script at
   `~/.openship/cred-<session>.sh`. It holds **no secret** — just `/dev/tcp/127.0.0.1/<port>` + a
   per-session nonce. Git is pointed at it via `GIT_CONFIG_*` (no `~/.gitconfig` write), and the
   clone uses a **plain URL** (no token in the remote `.git/config`). Before each networked Git
   command, the helper derives a short-lived Authorization header through the tunnel so GitHub sees
   an authenticated first request. This avoids GitHub's public-download throttle, which does not
   issue the 401 challenge that normally causes Git to consult a credential helper.
3. **Relay** — `openRelay` + `handleConnection` ([relay.ts](./relay.ts)) speak git's credential
   wire-protocol: validate the **nonce** (`timingSafeEqual`), pin **`host == github.com` + https**,
   **pin the repo** to the deploy's `owner/repo` (case-insensitive — denies any other), resolve the
   token via **`getLocalGhToken()`**, reply `username=x-access-token` + `password=<token>`. The header
   exists only in the short-lived shell/git process environment; it is absent from command text,
   files and logs. Per-relay **rate limit**; a structured **log line per request** (never the token).

The token reaches the remote only inside the short-lived helper/shell/git process memory and
environment for that one network operation — never in command text, on disk, or in `.git/config`.
The relay opens right before `runtime.build` and closes in a `finally`, so it's live only for the
build's duration.

## Scope of the forwarded token (important)

The `gh` token is **account-wide** — GitHub doesn't let us downscope an OAuth/`gh` token on the fly.
**True per-repo scoping comes only from the GitHub App installation token, which the deploy pipeline
already PREFERS**; this relay is the fallback for the local-`gh` case. The **repo-pin is therefore
defense-in-depth, not a hard wall**: a same-uid/root process on the live remote that can read the
`0700` helper could pose as the deploy's repo and still pull the full token. What the repo-pin _does_
guarantee is the relay never vends creds for any **other** repo. The hard protections remain:
desktop-only + per-deploy opt-in + short build-bounded window + nonce + host-pin.

## Security model

- Per-operation, never-persisted token; nonce-gated; host- and repo-pinned; rate-limited; logged
  (token-free).
- Open **only while the build is live** (opened pre-build, closed in `finally`).
- **Inherent trust assumption (same as VS Code):** while the tunnel is live, a same-uid/root process on
  that remote can read the `0700` script and obtain the (account-wide) token. That is why this is
  **desktop-only + opt-in per deploy**.

## Coverage

- **Key/password-auth servers** (ssh2 path) → the HTTPS relay works (`reverseForward` available).
- **Agent-auth servers** (OS-`ssh` path) → `reverseForward` is unavailable, so `openDeployRelay`
  returns `null` and the build errors clearly (use key/password auth, the GitHub App, or a per-project
  token).

## Files (this folder)

- `relay.ts` — the security core: reverse-tunnel handler + credential wire-protocol + nonce + host pin
  - repo pin + `gh` token + rate-limit + log + idempotent `close()`; the `0700` helper script
    (`buildHelperScript`/`writeHelperScript`).
- `deploy.ts` — `openDeployRelay` (the one consumer).
- `index.ts` — public API.

## Touch points outside this folder (intentional — generic infra / policy)

- **Reverse-tunnel primitive**: `reverseForward` on `packages/adapters/src/system/ssh-executor.ts`
  (+ `CommandExecutor.reverseForward` in `packages/adapters/src/system/types.ts`).
- **Deploy choice thread**: `DeploymentConfig.forwardGitCredentials`
  (`apps/dashboard/src/context/deployment/types.ts`) + the `DeployTargetStep` checkbox → the
  `buildAccess` payload (`useDeploymentBuild.tsx` + `apps/dashboard/src/lib/api/deploy.ts`) →
  `BuildAccessInput` → `DeploymentConfigSnapshot` in `requestBuildAccess`
  (`apps/api/src/modules/deployments/build.service.ts`) → the `allowRelayFallback` gate (desktop +
  server-build + opt-in) and the `openDeployRelay` call passing `project.gitOwner/gitRepo`
  (`apps/api/src/modules/deployments/build-pipeline.ts`).
- **Deploy token fallback**: `resolveBuildGitToken` in `apps/api/src/modules/github/clone-auth.ts`
  (returns `{ relay: true }` when no App/PAT + the deploy opted in) + the credential-helper clone branch
  in `packages/adapters/src/runtime/build-pipeline.ts`.

## Per-server GitHub auth (self-hosted)

The relay is ONE of several ways a clone authenticates. On self-hosted, a server can also carry its own
GitHub identity so clone-on-server works without the desktop being online. Stored per-server in
`server_github_auth` (encrypted), consulted FIRST by `resolveServerGitCredential`
(`apps/api/src/modules/github/server-github.service.ts`) inside `resolveBuildGitToken`
(`clone-auth.ts`), and clones via the shared `assembleGitClone` (`packages/adapters/src/runtime/git-clone.ts`).

Modes (a per-server switch, in the server detail → Security → GitHub card):

- **token** — a GitHub OAuth **device-flow** login (URL + code, same UX as `gh auth login`) OR a pasted
  PAT. The device flow runs once; the resulting token is stored **encrypted in our DB** and injected per
  clone exactly like a PAT — there is NO lingering live-`gh` dependency after login. The token is never
  returned to the client (the poll endpoint reports status only).
- **ssh-server-key** — one Ed25519 key generated on the host; the operator adds the public key to their
  GitHub account once. Clones over `git@github.com` with `GIT_SSH_COMMAND` + a 0600 key + pinned
  `known_hosts` (`github-known-hosts.ts`, `StrictHostKeyChecking=yes`).
- **ssh-deploy-key** — a read-only per-repo deploy key auto-registered via `POST /repos/{o}/{r}/keys`
  (needs repo Administration on the resolved token; 403 → actionable error). Revoked on disconnect.

Precedence: a configured server credential wins for THAT server's clones; App / project-PAT / user-PAT /
relay remain the fallback when it has none. Cloud (`CLOUD_MODE`) never reads any of this — App-token only.

Security: all secrets encrypted at rest (`lib/encryption.ts`), decrypted only at clone time, written to
0600 files removed in `finally`, and never logged (SSH keys go through `writeSecretFile` / `executor.writeFile`,
never the streamed `exec`). Preflight consults `canResolveServerGitCredential` so it reports the exact
credential the build will use.

## Status

Typechecked (db + adapters + api + dashboard, 0 errors) + adversarially reviewed. **Not yet runtime-tested**
against a live server + private repo. DB migration `packages/db/drizzle/0046_white_harrier.sql` adds
`server_github_auth` + `github_deploy_key`.
