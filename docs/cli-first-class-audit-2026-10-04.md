# Openship CLI review and fixes — 2026-10-04

The six defects reproduced in the original review are fixed in the current worktree. The CLI now exposes additional everyday management workflows through the shared SDK and contracts. This does **not** establish complete parity with every dashboard feature or live-provider readiness; the remaining limits are listed below.

The work started from `feat/cloud-workspaces` at `29d59829eb7e`. Existing unrelated billing, dashboard and platform changes were preserved. No production configuration was changed, and no package was published.

## Resolved findings

| Original finding | Resulting behavior and regression coverage |
| --- | --- |
| A context change could send context B's credential to API A during pagination or a later deployment phase. | The invocation captures its endpoints, token and capabilities once. All SDK clients created during that invocation use that snapshot. Real CLI subprocess tests change the active context and retarget the original context between requests, including source upload and deployment observation. The next invocation sees the new configuration. |
| An invalid instance import mode such as `merg` became `wipe`. | Commander rejects anything outside `merge` and `wipe` before a request. Default/explicit wipe still requires confirmation. Tests cover invalid, merge, explicit wipe and unconfirmed default inputs. |
| Setting one service environment key could erase concurrent writes or resend masked secrets. | Normal `service env set` uses `services.mergeEnvVars`. It reads source IDs for conflict detection, then sends only the requested keys. Unrelated variables and the engine's existing secret classification are preserved. Full replacement is available only with explicit `--replace`. Tests verify concurrent additions, source IDs, stale-write rejection, secret masking and replacement. |
| A linked remote project could silently deploy through a different context. | Links are checked against the selected context, canonical API URL and explicit organization. Native instance/organization checks remain in place. Explicit `--project` deliberately ignores an unrelated directory link. Tests assert refusal before network requests and the explicit-target path. |
| The deployment environment saved by `init` was ignored. | Deployment uses explicit `--env`, then the applicable link's default, then `production`. The shared deployment schema validates it. This selects a project's variable set; isolated runtimes use separate project IDs. |
| Authentication broke the global JSON output contract. | Login, logout and context mutations return secret-free JSON. Login and project selection refuse unexpected noninteractive prompts. Login validates through the named token SDK operation, then refreshes capabilities for the newly saved connection. Tests cover success, restricted-token access, rejection and target selection. |

Additional automation fixes:

- Domain and certificate verification return nonzero when unverified in both JSON and human modes. Credential, DNS-zone and notification verification also report unsuccessful outcomes with nonzero status.
- `deployment rm` requires confirmation or `--yes`; JSON/non-TTY execution does not imply permission.
- Invalid token expiry values are rejected instead of creating a nonexpiring token. Repeated options no longer mutate shared Commander defaults.
- `deployment wait`, `deploy --watch` and deployment-log following have bounded observation. The default is ten minutes. Timing out does not cancel the deployment; pending prompts return to the caller for an explicit decision.
- Cloud request-log following is implemented in the SDK. It discovers the authorized stream and uses only its issued token, never the instance bearer credential, cookies or organization header. Redirects are refused. Unavailable streams fail explicitly. Early return cancels the reader; signed URLs and tokens are excluded from transport/read errors.

## Added named workflows

| Area | CLI entry points | Shared owner |
| --- | --- | --- |
| Project configuration | `project update`, `resources get/set`, `environment list/create` | Project SDK operations and shared input contracts |
| Storage and app connections | `project storage`, `project connections` | Existing project storage/connection operations |
| Recovery inspection | `project pending`, `incidents`, `drift`, `rollback-capacity`; `deployment wait` | Project operations and the SDK deployment handle |
| Service configuration and environment | `service update`; `service env inspect/reveal/delete/apply` | Service SDK operations, including the existing atomic replacement/rollback workflow |
| Monitoring | `monitoring issues/summary/health/scan/rescan`; `monitoring watch enable/disable` | Issues and jobs operations; watcher key and capability come from the engine |
| Credentials and DNS | `credential`, `dns`, `domain dns`, `domain remove` | Credentials, DNS and domain operations; challenge actions require the exact attempt ID |
| Notifications and hooks | `notification`, `webhook` | Existing notification/webhook operations, actor checks and delivery history |
| Workspace access | `access`, global `--organization` | Permissions operations and SDK fixed-organization protocol/authorization checks |
| Audit | `audit list/facets/settings` | Shared audit operations and retention rules |

The CLI owns command syntax, local link/configuration handling, confirmation, exit status and terminal output. Public resource validation remains in `@repo/contracts`; transport and deployment observation remain in the SDK; business logic, provider selection, authorization, environment locking and rollback remain in the engine. No alternate Cloud provisioner, environment replacement implementation or monitoring scheduler was introduced.

## Verification

| Check | Result |
| --- | --- |
| CLI TypeScript check | Passed |
| CLI suite | 615 tests passed across 50 files |
| Native CLI integration | All 9 cases passed against real Node workers and temporary PGlite databases; included in the CLI count |
| SDK suite | 198 tests passed across 16 files, including signed-stream error/cancellation cases |
| Final Cloud log regressions | 14 tests passed, including credential isolation, cancellation and secret-free errors |
| Public package build | Passed, including final stream-error hardening |
| Installed npm artifact on Node 22.21.1 | Final artifact passed ESM/CommonJS, declarations, passive imports, native deployment/redeployment, persistence, tenant isolation, revocation, teardown, remote submission, npm command resolution and native CLI checks |
| Documentation | 179 pages compile, navigation/links resolve; 332 CLI command paths match generated help; 267 CLI and 124 SDK examples checked; shared API/MCP references match |
| Whitespace check | `git diff --check` passed |

Remote command regression tests use real assembled CLI subprocesses and the SDK transport against isolated loopback fixture APIs with fake credentials. Native tests use the real engine and disposable databases. The installed package check runs outside the repository. These checks did not deploy to live Cloud, Docker or SSH servers.

## Compatibility notes

- Scripts relying on exit 0 for unverified domains in JSON mode must handle the nonzero result.
- Unattended deletion requires `--yes`; unattended login/linking requires explicit credentials/project IDs.
- Existing links with a saved context now reject a different active context. New links also record the canonical endpoint and an explicitly selected organization. Relink with `init --force` to intentionally change a directory's association.
- Service environment writes save configuration. Use `service env apply` to apply it to the active service through the engine, or deploy it. Environment text is application data; the CLI does not impose app-specific URL rules.
- `--organization` is for remote SDK resource commands. Native organization selection stays in the trusted native configuration. Unsupported fixed-scope Cloud forwarding is refused by the SDK rather than falling back to an unscoped request.

## Remaining coverage and release limits

The CLI is substantially more capable, but full platform parity is still unfinished:

- `server ssh` remains an explicit unsupported interactive-terminal path. Existing bounded `server exec` is separate.
- Mail, overlapping edge operations and parts of system administration still use remote-only HTTP commands and need named shared SDK adoption. Some required SDK/engine migrations are themselves unfinished; see the [SDK status](../packages/sdk/README.md) and [migration audit](ship-sdk-migration-audit.md).
- GitHub connection/source administration, private networks/compute clusters/shared-storage operations, and dedicated Cloud destination/billing management still lack complete named CLI workflows.
- Catalog drafts/installations have existing CLI support, but a live Cloud/self-hosted catalog installation matrix was not exercised here.
- Live Cloud, Docker and SSH tests remain separate release gates. A passing fixture or native test is not evidence that a provider account, quota, network or external service is ready.

Further CLI coverage should call the existing typed SDK operations. Operations missing from the shared surface should first be migrated there with authorization and parity tests, rather than adding provider logic to command handlers. Internal callbacks and provider webhooks do not need user-facing CLI verbs.

Local verification artifacts are under `/tmp/openship-cli-fix-*` and `/tmp/openship-sdk-fix-tests.*`. Original before-fix probes are under `/tmp/openship-cli-review-*`; they reproduce the old bad behavior and are not acceptance tests for the fix.
