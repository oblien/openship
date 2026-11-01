# Security Guide — where to look

> This is **not** the vulnerability-disclosure policy (that's [`SECURITY.md`](./SECURITY.md)).
> This is a map for contributors and reviewers: **the security-sensitive surface of the app
> lives at its entry points** — the places where untrusted input, credentials, or shell/SSH
> execution cross a trust boundary. If you're auditing a change, touching one of these, or
> reviewing a PR, start here. Everything else is downstream of these doors.

The app is a monorepo: `apps/api` (Hono backend — the real trust boundary), `apps/dashboard`
(Next.js UI), `apps/cli` + `apps/desktop` (self-host launchers), `packages/adapters` (SSH /
runtime / remote execution), `packages/{core,db}`. **Almost all security-relevant code is in
`apps/api` and `packages/adapters`.** The dashboard is a client — never trust it for
enforcement; the API must re-check everything.

---

## The two golden invariants

Real RCE / takeover bugs in this codebase came from violating these. Hold them sacred:

1. **Shell-quote every remote-exec argument.** Never interpolate a user/DB value into a
   command string or a heredoc. Use the single-quote escaper `sq()`
   (`packages/adapters/src/system/local-shell.ts`). Applies to every command sent over SSH.
2. **`zeroAuthAllowed()` is the single zero-auth gate.** Desktop can run without a login;
   every other target must not. There is exactly one function that decides this
   (`apps/api/src/middleware/auth.ts`, mirrored by `middleware/zero-auth-guard.ts`). Do not
   add a second "skip auth" path.

Supporting invariants: SSH keys are `0600`; `known_hosts` is pinned with
`StrictHostKeyChecking=yes` (**never** `accept-new`) and never logged; credentials are
encrypted at rest and **never returned to the client**; auto-registered GitHub deploy keys are
read-only and revocable; instance-global jobs must authorize the server ids they act on.

---

## 1. Public HTTP entry + auth — `apps/api/src/middleware/`

The front door. Every request passes through here before it reaches a route.

| File | What it guards |
|---|---|
| `auth.ts` | Session/token auth; **`zeroAuthAllowed()`** — the one zero-auth gate. |
| `zero-auth-guard.ts` | Enforces the above per-route. |
| `internal-auth.ts` | `INTERNAL_TOKEN` for machine-to-machine / bootstrap calls (CLI admin bootstrap). |
| `mcp-consent.ts` | OAuth/consent for MCP clients (preserves `client_id`, `redirect_uri`, `code_challenge`, `state`). |
| `origin-guard.ts`, `loopback-peer.ts`, `local-only.ts` | Origin/host/loopback restrictions (desktop-login redirect alignment lives near here). |
| `client-ip.ts` | Trusted client-IP resolution (XFF is trusted only behind the OpenResty edge). |
| `rate-limiter.ts` | Global rate limiting (policies in `apps/api/src/lib/rate-limit/`). |
| `active-organization.ts`, `migration-guard.ts`, `better-auth-shield.ts` | Org scoping + Better-Auth hardening. |

**Enforcement primitives** (`apps/api/src/lib/`): `secure-router.ts` (every route declares a
permission `tag`), `permission.ts` + `route-permission.ts` (RBAC checks), `auth-mode.ts`
(cloud vs self-hosted mode), `auth.ts` (Better-Auth config; `BETTER_AUTH_SECRET`).

**Rule:** a route with no permission tag on `secure-router` is a bug. The dashboard hiding a
button is not a control — the API tag is.

## 2. Webhooks — `apps/api/src/modules/{github,billing}/`

Unauthenticated-by-URL entry points; they authenticate by **HMAC signature over the raw body**
and dedupe by delivery id. Verify signature *before* parsing.

- `github/github.webhook.ts` (+ `webhook-shared.ts`, `webhook-installation.ts`,
  `webhook-event-prune-schedule.ts`) — push → auto-deploy; delivery-id idempotency; cloud
  webhook forwarding.
- `billing/oblien-webhook.controller.ts` + `oblien-webhook-crypto.ts` — Oblien billing
  webhook; `X-Webhook-Signature` = HMAC of the **raw** request body (not the parsed JSON).
- `modules/webhooks/` — per-project backup/deploy trigger webhooks (token-scoped).

**Rule:** never trust a webhook payload until the signature check passes; never dedupe on
content when a delivery id exists.

## 3. Remote execution over SSH — `packages/adapters/src/system/` + `apps/api/src/lib/ssh-manager.ts`

The highest-blast-radius surface: these run commands **as root on the user's servers**.

- `system/executor.ts`, `ssh-executor.ts`, `system-ssh-executor.ts` — the SSH command
  channel. `local-shell.ts` holds `sq()` (see invariant #1).
- `system/elevated-executor.ts` — `sudo -n` elevation for non-root SSH users (component
  installs). Wraps commands via `sq()`; never blanket-`sudo -E`.
- `system/installer.ts`, `environment.ts`, `catalog.ts` — component install recipes (apt/
  systemctl/writes under `/etc`). Every privileged command goes through elevation.
- `system/edge-takeover.ts`, `edge-preflight.ts` — port 80/443 takeover; consent-gated,
  never blind-kills a foreign proxy.
- `apps/api/src/lib/ssh-manager.ts` — builds the SSH config, resolves the key path
  (`ssh-key-path.ts` — traversal-checked allowlist), pins `known_hosts`.

**Rule:** any new remote command must (a) be `sq()`-quoted, (b) go through an executor, not a
hand-built `ssh` string, and (c) never echo a secret into the command line or logs.

## 4. Git clone + credential forwarding — `apps/api/src/lib/git-forwarding/` + `modules/deployments/`

How private repos are cloned on a build host without persisting a token.

- `lib/git-forwarding/relay.ts` — the SSH reverse-tunnel credential relay (desktop only,
  repo-pinned, streamed for the clone, **never written to disk**).
- `modules/deployments/clone-plan.ts` — decides where the clone runs (api-host vs server) and
  which credential (relay / App / PAT / per-server); the single source both preflight and the
  build pipeline read.
- `modules/deployments/build-pipeline.ts`, `build.service.ts` — the build; graceful degrade to
  an api-host clone when no credential reaches the server.
- `modules/github/server-github.service.ts` + `packages/adapters/src/runtime/git-clone*.ts` —
  per-server GitHub credentials (encrypted; device-flow / PAT / SSH key / read-only deploy
  keys). Disconnect **hard-deletes** the stored token and revokes deploy keys.

## 5. Mail server (provisioning) — `apps/api/src/modules/mail/`

Provisions a full mail stack (iRedMail) over SSH — heavy root-level remote work.

- `mail.service.ts` — the provisioning flow (apt, systemctl, `/etc/hosts`, DKIM, certbot).
  The only lateral privilege drop is `sudo -u postgres` for the mail DB.
- `mail-credentials.service.ts`, `admin/psql-runner.ts` — mailbox credential handling
  (Postgres via `sudo -u postgres psql`; shell-quote the SQL args).
- `mail-state.ts` — provisioning state (`mail-state.json`); branding lives on disk, not SQLite.
- `admin/` — the in-app mail admin (replaces iRedAdmin via SSH + psql). Treat every psql arg
  as untrusted input.

## 6. Mail client / webmail — `apps/api/src/modules/mail/webmail/`

Deploys the Zero webmail UI (self-host stack, or pointed at an external IMAP/SMTP backend).

- `webmail/` — deploy flow (behind the OpenResty edge; XFF trusted there). External-backend
  connect pastes SMTP/IMAP credentials → encrypted at rest (see §8), never re-shown.
- Instance SMTP transport (system mail: password resets, invites) —
  `apps/api/src/modules/system/setup.controller.ts` (`/system/settings/email`); password
  encrypted server-side, blank on read.

## 7. Cloud / multi-tenant boundary — `apps/api/src/lib/cloud-auth-proxy.ts`, `cloud-route.service.ts`

- `apps/api/src/modules/cloud/cloud-relay-access.ts` checks the selected managed
  server before legacy token, Page, preflight, or resource relay operations.
  An omitted selector must enforce the same host permission as an explicit one;
  a Cloud feature grant alone must not issue a provider execution credential.
- `packages/db/src/dump.ts` validates imported references against tables that
  actually travel in the chosen scope. Cloud ingest also scrubs runtime handles
  on receipt; export-side scrubbing is not an authorization boundary. Restore
  and promotion receipts commit in one transaction.
- `packages/platform/src/engine/lib/edge-host-executor.ts` verifies recorded
  servers against the project's organization. Its self-hosted certificate and
  SSH readers are disabled in Cloud mode.

When `CLOUD_MODE` is set the API is a multi-tenant SaaS gateway. Several self-hosted-only paths
(the `gh` CLI, device flow, local file reads) are **hard-floored off** here — see the
`env.CLOUD_MODE` early-returns in `apps/api/src/modules/github/github.local-auth.ts`.

**Rule:** anything that shells out locally or reads the host filesystem must check
`env.CLOUD_MODE` first. Cloud projects are canonical on the SaaS; the local API proxies.

## 8. Secrets at rest — `apps/api/src/lib/encryption.ts` + `credential-encryption.ts`

One envelope for every stored secret (SSH creds, GitHub tokens, S3/SFTP backup creds, project
env vars, SMTP passwords).

- AES-256-GCM, key = `SHA-256(BETTER_AUTH_SECRET)`. Ciphertext is tagged `enc1:` so plaintext
  vs encrypted is explicit (no silent decrypt-fallback).
- `BETTER_AUTH_SECRET` defaults to a placeholder only on `target=local`; a deployable target
  **refuses to boot** on the placeholder (`apps/api/src/config/env.ts`). The CLI auto-generates
  a per-install secret (`~/.openship/auth-secret`, `0600`).

**Rule:** serialized/API-returned objects expose only `hasX` flags, never ciphertext or
plaintext. Losing the secret makes every stored credential undecryptable — treat it as such.

## 9. Domains, SSL & the edge — `apps/api/src/lib/{domain-ssl,routing-domains,cloud-route}.ts` + `packages/adapters/src/infra/`

- Custom-domain verify → DNS-records → SSL (certbot) pipeline; hostname normalization is
  cross-tenant-safe; certbot gated on verification.
- OpenResty routing writes + reloads (`packages/adapters/src/infra/nginx.ts`, `openresty-lua.ts`)
  and the per-route Lua rules engine (rate-limit / ban / country / UA) — DB is source of truth,
  pushed to a shared dict.

## 10. Tokens, PAT & MCP scopes — `apps/api/src/modules/{auth,permissions}/`

- PAT / MCP token scopes and grants; the "projects it creates" scope is a
  `{project,"*",[create]}` grant (wildcard-project must be create-only, enforced at mint).
- List endpoints must filter to the token's grants (isolation), not just check the action.

---

## Reviewer checklist

- New route? → has a permission `tag` on `secure-router`, and re-checks org scope.
- New remote command? → `sq()`-quoted, via an executor, no secret in argv/logs.
- New webhook? → HMAC-verified against the **raw** body before parsing; delivery-id deduped.
- New stored secret? → goes through `encryptSecretField`; only `hasX` leaves the API.
- Touches auth skipping? → routes through `zeroAuthAllowed()`, nowhere else.
- Runs anything locally / reads the host FS? → guarded by `env.CLOUD_MODE`.
- Deletes/overwrites a credential? → confirm it's a hard delete + external revoke where relevant.
