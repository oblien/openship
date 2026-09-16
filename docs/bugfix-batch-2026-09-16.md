# Bug review batch — 2026-09-16

Base: `4e66349c27b48df13697c1b6d4a95f7a6cf4a3d6` (`main`, including merged PR #891).

Integration: [PR #892](https://github.com/oblien/openship/pull/892), branch `feat/bugfix-batch-2026-09-16`. Review every currently open report from newest to oldest, including unresolved reports from the previous review and their follow-up comments. This supersedes the initial selection of 50 previously unreviewed reports. New capabilities remain outside this bug-fix batch.

The previous integration worktree and old branches, including `ship`, were removed after verifying their tips are in main. User changes on main are preserved. Adaptable contributor PRs are edited and merged into this branch with their original history and GitHub merge credit.

## Progress

5 already-fixed-main; 54 deferred-feature; 7 fixed-in-branch; 5 needs-reproduction; 2 partial-branch; 2 partial-main; 31 pending-review. Pending reports have not yet completed review. Nothing in this branch has been merged into main.

## Issue ledger

| Issue | Report | Status | Linked PRs |
| --- | --- | --- | --- |
| [#879](https://github.com/oblien/openship/issues/879) | [Bug]: [0.7.2] Custom domains at project level are verified + certified but never routed locally; self-app domain cannot converge (host-port claim conflict) | fixed-in-branch | — |
| [#878](https://github.com/oblien/openship/issues/878) | [Improvement]: Deployments don't use external repository and rebuild images instead | needs-reproduction | — |
| [#877](https://github.com/oblien/openship/issues/877) | [Feature]: Add Porkbun as a supported DNS Provider | deferred-feature | — |
| [#876](https://github.com/oblien/openship/issues/876) | [Bug]: Email service is waiting for emails to go out forever | needs-reproduction | [#885](https://github.com/oblien/openship/pull/885) |
| [#873](https://github.com/oblien/openship/issues/873) | [Bug]: `openship.json`'s `monorepo` config (and CLI `project create --type monorepo`) is documented and schema-valid, but doesn't actually produce a multi-app project through any available path | partial-main | — |
| [#872](https://github.com/oblien/openship/issues/872) | [Bug]: Global GitHub device-flow connection intermittently shows "rejected".  The status is backed by a Redis cache entry with a ~100 second TTL, not the actual GitHub authorization state | needs-reproduction | — |
| [#869](https://github.com/oblien/openship/issues/869) | Migrate to self-hosted server never actually deploys (3 stacked bugs: missing deploy trigger, release-dist path/packaging mismatch, PGlite assets crash) | partial-main | — |
| [#856](https://github.com/oblien/openship/issues/856) | [Feature]: Add Authentik to the one-click app catalog | deferred-feature | [#857](https://github.com/oblien/openship/pull/857) |
| [#849](https://github.com/oblien/openship/issues/849) | [Feature Request] Add CLI commands for self-hosted jobs | deferred-feature | [#850](https://github.com/oblien/openship/pull/850) |
| [#846](https://github.com/oblien/openship/issues/846) | [Bug] Compose services cannot join a pre-existing external Docker network (background workers are unreachable from shared services) | deferred-feature | — |
| [#819](https://github.com/oblien/openship/issues/819) | [Feature] Multi-wildcard domains, control plane isolation, 7000-series port standardization, and dashboard domain management | deferred-feature | — |
| [#818](https://github.com/oblien/openship/issues/818) | [Feature] Outbound relay domain verification notice and client privacy header scrubbing | deferred-feature | — |
| [#779](https://github.com/oblien/openship/issues/779) | Enhance self-hosted image retention with age-based cleanup and runtime image visibility | deferred-feature | [#794](https://github.com/oblien/openship/pull/794), [#820](https://github.com/oblien/openship/pull/820) |
| [#773](https://github.com/oblien/openship/issues/773) | Timeouts on several features | needs-reproduction | — |
| [#764](https://github.com/oblien/openship/issues/764) | feat(webmail): configurable sender name and email signatures | deferred-feature | — |
| [#758](https://github.com/oblien/openship/issues/758) | Support multiple isolated workspaces on a self-hosted OpenShip instance | deferred-feature | — |
| [#749](https://github.com/oblien/openship/issues/749) | feat(compose): preserve container hardening controls | deferred-feature | [#871](https://github.com/oblien/openship/pull/871) |
| [#717](https://github.com/oblien/openship/issues/717) | [Feature]: Support Git tags and tag patterns as deployment and update triggers | deferred-feature | [#716](https://github.com/oblien/openship/pull/716) |
| [#695](https://github.com/oblien/openship/issues/695) | OPENSHIP | needs-reproduction | — |
| [#694](https://github.com/oblien/openship/issues/694) | [Feature]: Support release mode and update tracking for container image projects | deferred-feature | [#691](https://github.com/oblien/openship/pull/691) |
| [#676](https://github.com/oblien/openship/issues/676) | Feature request: cap/serialize concurrent builds (auto-deploy fan-out corrupts containerd content store) | deferred-feature | — |
| [#672](https://github.com/oblien/openship/issues/672) | feature: service restarting auto detection after new deployments in background (not blocking) and mark project partial failed or action required if there's loop restarting | deferred-feature | — |
| [#671](https://github.com/oblien/openship/issues/671) | feature:  on deployments list add standalone remove snapshot option and ensure the snapshot data removed when delete the deployment info | deferred-feature | — |
| [#669](https://github.com/oblien/openship/issues/669) | feature: add publish env button after update env / updated env without need to redeploy it, as fast env update in services / project | deferred-feature | [#681](https://github.com/oblien/openship/pull/681) |
| [#668](https://github.com/oblien/openship/issues/668) | Services logs hang out / takes too much time to show logs, terminal not load with silent fail in desktop | partial-branch | — |
| [#667](https://github.com/oblien/openship/issues/667) | feature: showing the live service / project logs after deployment finish in deployment page if the deployment success instead of keeping the logs | deferred-feature | [#708](https://github.com/oblien/openship/pull/708) |
| [#662](https://github.com/oblien/openship/issues/662) | feature request: support deploy another service on same domain but with another path | deferred-feature | — |
| [#661](https://github.com/oblien/openship/issues/661) | ensure release checks not duplicated | fixed-in-branch | — |
| [#660](https://github.com/oblien/openship/issues/660) | home issues shortcut update need to be background based, and opening issues can view the logs inside the page instead of showing it as modal | fixed-in-branch | — |
| [#659](https://github.com/oblien/openship/issues/659) | Server unreachable cause edge not exist issue, while the entire server is unreachable | already-fixed-main | — |
| [#658](https://github.com/oblien/openship/issues/658) | ensuring project delete does not leave any tails or un cleaned up resources | already-fixed-main | — |
| [#638](https://github.com/oblien/openship/issues/638) | [Bug]: Draft project deletion executes immediately without confirmation dialog | fixed-in-branch | [#639](https://github.com/oblien/openship/pull/639) |
| [#624](https://github.com/oblien/openship/issues/624) | Persist the git clone URL instead of building github.com/owner/repo | deferred-feature | — |
| [#612](https://github.com/oblien/openship/issues/612) | Feature: optional label on domain entries — "Domain 2" cards lose meaning on multi-domain projects (web + websocket ports) | deferred-feature | — |
| [#610](https://github.com/oblien/openship/issues/610) | Clarify licensing boundary for apps/email/engine | partial-branch | — |
| [#608](https://github.com/oblien/openship/issues/608) | [Bug]: Shows no system info for macbook | fixed-in-branch | [#645](https://github.com/oblien/openship/pull/645), [#888](https://github.com/oblien/openship/pull/888) |
| [#577](https://github.com/oblien/openship/issues/577) | Feature: let a catalog app declare its default backup policy, so one click covers every service instead of a ten-field form each | deferred-feature | [#578](https://github.com/oblien/openship/pull/578) |
| [#568](https://github.com/oblien/openship/issues/568) | [Bug] Webmail branding: siteTitle and siteDescription are accepted but never rendered, and the vendor footer is not brandable | already-fixed-main | — |
| [#558](https://github.com/oblien/openship/issues/558) | [Feature] Make Projects the entrypoint of app deployment | deferred-feature | [#744](https://github.com/oblien/openship/pull/744) |
| [#556](https://github.com/oblien/openship/issues/556) | Upstream-down hostnames return a raw OpenResty 502 instead of a friendly “Application unavailable” page | pending-review | [#557](https://github.com/oblien/openship/pull/557) |
| [#541](https://github.com/oblien/openship/issues/541) | feat(cli): `openship deployment bisect` — binary-search deployment history for the first bad deploy | deferred-feature | [#542](https://github.com/oblien/openship/pull/542) |
| [#535](https://github.com/oblien/openship/issues/535) | [Feature] Support buildStrategy: "local" for Docker stacks — build the image on the control-plane host and ship it to the target server | deferred-feature | — |
| [#530](https://github.com/oblien/openship/issues/530) | feat: enable the Uptime Kuma app template | deferred-feature | [#531](https://github.com/oblien/openship/pull/531) |
| [#527](https://github.com/oblien/openship/issues/527) | Experience as first time / new user | pending-review | — |
| [#521](https://github.com/oblien/openship/issues/521) | RFC: External installable plugin architecture (versioned outside core) | deferred-feature | — |
| [#513](https://github.com/oblien/openship/issues/513) | Add Kan.bn to the apps catalog | deferred-feature | [#522](https://github.com/oblien/openship/pull/522), [#534](https://github.com/oblien/openship/pull/534) |
| [#512](https://github.com/oblien/openship/issues/512) | Add Shoutrrr to the apps catalog | deferred-feature | [#526](https://github.com/oblien/openship/pull/526), [#534](https://github.com/oblien/openship/pull/534) |
| [#509](https://github.com/oblien/openship/issues/509) | Docker app deployment fails because the host channel is not provisioned | pending-review | [#518](https://github.com/oblien/openship/pull/518) |
| [#506](https://github.com/oblien/openship/issues/506) | [Bug] Same-server migration leaves app unreachable — "Auto" routing mode doesn't publish a loopback port | pending-review | [#499](https://github.com/oblien/openship/pull/499), [#508](https://github.com/oblien/openship/pull/508) |
| [#505](https://github.com/oblien/openship/issues/505) | [Feature] Allow dismissing/ignoring an issue (edge_absent et al.) — or a per-server component opt-out | deferred-feature | — |
| [#504](https://github.com/oblien/openship/issues/504) | ConnectionCard is hidden for non-catalog projects — "Use in a project" is unreachable for single-app/compose/monorepo sources | pending-review | [#507](https://github.com/oblien/openship/pull/507) |
| [#501](https://github.com/oblien/openship/issues/501) | Laravel asset build fails when a package ships CSS from vendor/ (Livewire Flux, Filament) — the asset stage has no vendor/ | fixed-in-branch | [#467](https://github.com/oblien/openship/pull/467) |
| [#500](https://github.com/oblien/openship/issues/500) | `onFailure` destroys carried-forward (still-live) containers when a compose deploy fails — a failed redeploy can take down the running app | already-fixed-main | [#517](https://github.com/oblien/openship/pull/517) |
| [#495](https://github.com/oblien/openship/issues/495) | [Feature]: MFA for server accounts | deferred-feature | [#772](https://github.com/oblien/openship/pull/772) |
| [#488](https://github.com/oblien/openship/issues/488) | up dry-run reports POSTGRES_PASSWORD=<preserved> but writes a newly generated password | pending-review | [#496](https://github.com/oblien/openship/pull/496) |
| [#487](https://github.com/oblien/openship/issues/487) | OPENSHIP_PGDATA detection picks the volume root when re-installing over an existing pgdata/ subdirectory | pending-review | [#494](https://github.com/oblien/openship/pull/494) |
| [#483](https://github.com/oblien/openship/issues/483) | add X as a notification delivery channel | deferred-feature | — |
| [#433](https://github.com/oblien/openship/issues/433) | 🔄 Request: More Frequent `dev` Branch Updates + Release Channel Switcher | deferred-feature | — |
| [#429](https://github.com/oblien/openship/issues/429) | [Bug + Feature Request] Deleted emails stuck with TRASH label & no auto-refresh on new email | pending-review | [#430](https://github.com/oblien/openship/pull/430), [#478](https://github.com/oblien/openship/pull/478) |
| [#428](https://github.com/oblien/openship/issues/428) | Feature Request: Show a friendly "Service Not Found" page for unrecognized hostnames instead of raw SSL/TLS errors | deferred-feature | — |
| [#426](https://github.com/oblien/openship/issues/426) | [Bug] Terminal session counter not reset after browser disconnect — ghost sessions block new shells indefinitely | fixed-in-branch | [#432](https://github.com/oblien/openship/pull/432), [#579](https://github.com/oblien/openship/pull/579) |
| [#424](https://github.com/oblien/openship/issues/424) | How to change the binding IP address of container? | pending-review | — |
| [#417](https://github.com/oblien/openship/issues/417) | Support Cloudflare Email Sending in self-hosted SMTP settings | deferred-feature | — |
| [#415](https://github.com/oblien/openship/issues/415) | Add OpenTelemetry Collector to the apps catalog | deferred-feature | [#416](https://github.com/oblien/openship/pull/416), [#534](https://github.com/oblien/openship/pull/534) |
| [#411](https://github.com/oblien/openship/issues/411) | [Feature Request] Allow login with username only (without @domain) on single-domain setup | deferred-feature | — |
| [#410](https://github.com/oblien/openship/issues/410) | Rollback action permanently disabled on every deployment — status string mismatch ("ready" vs "success") | already-fixed-main | [#542](https://github.com/oblien/openship/pull/542) |
| [#408](https://github.com/oblien/openship/issues/408) | Docker health check shows Unhealthy on external server added via SSH (password auth) despite Docker running normally | pending-review | [#422](https://github.com/oblien/openship/pull/422) |
| [#402](https://github.com/oblien/openship/issues/402) | Add a standalone PostgreSQL app to Install App or make database services easier to find | deferred-feature | [#405](https://github.com/oblien/openship/pull/405) |
| [#401](https://github.com/oblien/openship/issues/401) | Add SeaweedFS as an Install App option for self-hosted object storage | deferred-feature | [#406](https://github.com/oblien/openship/pull/406) |
| [#399](https://github.com/oblien/openship/issues/399) | Add a standalone PostgreSQL app to Install App or make database services easier to find | deferred-feature | — |
| [#398](https://github.com/oblien/openship/issues/398) | Add SeaweedFS as an Install App option for self-hosted object storage | deferred-feature | — |
| [#397](https://github.com/oblien/openship/issues/397) | Add TanStack Start support to framework detection and project setup | deferred-feature | — |
| [#396](https://github.com/oblien/openship/issues/396) | Overview page shows 0 requests / no traffic data on some projects (silent AbortError in root layout) | pending-review | [#421](https://github.com/oblien/openship/pull/421) |
| [#392](https://github.com/oblien/openship/issues/392) | [Bug] smtp_tls_security_level set to "encrypt" breaks inbound mail delivery via Amavis | pending-review | [#423](https://github.com/oblien/openship/pull/423), [#477](https://github.com/oblien/openship/pull/477) |
| [#391](https://github.com/oblien/openship/issues/391) | [Bug] Relay SMTP settings not applied to webmail container + logout redirects to 404 | pending-review | [#420](https://github.com/oblien/openship/pull/420), [#476](https://github.com/oblien/openship/pull/476) |
| [#390](https://github.com/oblien/openship/issues/390) | Bug: Latest version broke the cli | pending-review | — |
| [#388](https://github.com/oblien/openship/issues/388) | Migrating coolify to openship issues | pending-review | — |
| [#382](https://github.com/oblien/openship/issues/382) | [Feature]: First-class Forgejo/Gitea/Gogs integration | deferred-feature | — |
| [#381](https://github.com/oblien/openship/issues/381) | Openship Windows Path Bug | pending-review | [#425](https://github.com/oblien/openship/pull/425) |
| [#379](https://github.com/oblien/openship/issues/379) | Help Wanted: Replace GitHub-Only Integration with Multi-Git Provider Support | deferred-feature | [#386](https://github.com/oblien/openship/pull/386) |
| [#378](https://github.com/oblien/openship/issues/378) | How to deploy Static HTML? | pending-review | — |
| [#316](https://github.com/oblien/openship/issues/316) | Docker Swarm stack-native deployment support | deferred-feature | [#317](https://github.com/oblien/openship/pull/317) |
| [#309](https://github.com/oblien/openship/issues/309) | feat/bug: Laravel deployment issues – Service stuck in Stopped state, orphan container, missing database linking, web terminal/CLI & volume persistence | pending-review | [#469](https://github.com/oblien/openship/pull/469) |
| [#282](https://github.com/oblien/openship/issues/282) | I can't verify my custom domain - whole flow is a bit complicated, needs a bit of UX improvement as well. | pending-review | — |
| [#278](https://github.com/oblien/openship/issues/278) | I could not find where I could change project name. | pending-review | [#313](https://github.com/oblien/openship/pull/313) |
| [#264](https://github.com/oblien/openship/issues/264) | Email encryption at rest using OpenPGP | deferred-feature | — |
| [#261](https://github.com/oblien/openship/issues/261) | Shell shebang should respect the correct machine setup | pending-review | — |
| [#258](https://github.com/oblien/openship/issues/258) | Am i have to use github? which is public.. a bit not trusted... they sometime leak something... | pending-review | — |
| [#256](https://github.com/oblien/openship/issues/256) | Support ACME External Account Binding (EAB / HMAC) for certificate issuance | deferred-feature | [#1](https://github.com/oblien/openship/pull/1), [#2](https://github.com/oblien/openship/pull/2), [#3](https://github.com/oblien/openship/pull/3), [#4](https://github.com/oblien/openship/pull/4), [#5](https://github.com/oblien/openship/pull/5), [#380](https://github.com/oblien/openship/pull/380) |
| [#240](https://github.com/oblien/openship/issues/240) | [Bug] Mail health check: three false positives (SpamAssassin daemon, desktop-resolver DNS scan, DKIM baseline) | pending-review | [#319](https://github.com/oblien/openship/pull/319) |
| [#231](https://github.com/oblien/openship/issues/231) | Discussion: multi-process apps and the single-start-command model (Laravel as the case study) | pending-review | [#468](https://github.com/oblien/openship/pull/468), [#469](https://github.com/oblien/openship/pull/469), [#592](https://github.com/oblien/openship/pull/592) |
| [#220](https://github.com/oblien/openship/issues/220) | Webmail: CSS url()/@import bypasses remote-image blocking, leaking a read receipt with images off | pending-review | [#219](https://github.com/oblien/openship/pull/219), [#222](https://github.com/oblien/openship/pull/222) |
| [#216](https://github.com/oblien/openship/issues/216) | Help: Heavy tests needed for the stable release | pending-review | [#193](https://github.com/oblien/openship/pull/193), [#219](https://github.com/oblien/openship/pull/219), [#224](https://github.com/oblien/openship/pull/224), [#243](https://github.com/oblien/openship/pull/243), [#247](https://github.com/oblien/openship/pull/247), [#248](https://github.com/oblien/openship/pull/248) |
| [#197](https://github.com/oblien/openship/issues/197) | Feature request: Telegram notification channel | deferred-feature | — |
| [#195](https://github.com/oblien/openship/issues/195) | Preview deploy overwrites the production active-deployment pointer | pending-review | [#196](https://github.com/oblien/openship/pull/196) |
| [#192](https://github.com/oblien/openship/issues/192) | Publish changelog entries in GitHub Release descriptions | pending-review | [#591](https://github.com/oblien/openship/pull/591) |
| [#188](https://github.com/oblien/openship/issues/188) | Feature Request: Native Object Storage Support | deferred-feature | — |
| [#163](https://github.com/oblien/openship/issues/163) | Clarification needed: Multi-node clustering storage and volume handling strategy | pending-review | — |
| [#159](https://github.com/oblien/openship/issues/159) | Feature Request: Resend Mail Integration | deferred-feature | — |
| [#148](https://github.com/oblien/openship/issues/148) | Help us Keep OpenShip more secure : | pending-review | [#152](https://github.com/oblien/openship/pull/152), [#193](https://github.com/oblien/openship/pull/193), [#224](https://github.com/oblien/openship/pull/224) |
| [#137](https://github.com/oblien/openship/issues/137) | Feature Request: seperating email flow and module into dedicated install | deferred-feature | [#141](https://github.com/oblien/openship/pull/141) |
| [#123](https://github.com/oblien/openship/issues/123) | Global rate-limiter always applies default-anon, and double-charges routes that set their own policy | pending-review | [#232](https://github.com/oblien/openship/pull/232) |
| [#92](https://github.com/oblien/openship/issues/92) | [Feature]: Canvas feature | deferred-feature | [#600](https://github.com/oblien/openship/pull/600) |
| [#75](https://github.com/oblien/openship/issues/75) | [Feature]: First-class GitLab integration (connect, push-to-deploy, MR previews) | deferred-feature | [#177](https://github.com/oblien/openship/pull/177), [#386](https://github.com/oblien/openship/pull/386), [#593](https://github.com/oblien/openship/pull/593) |
| [#72](https://github.com/oblien/openship/issues/72) | [Feature]: Allow Rspamd to replace SpamAssassin as Amavis anti-spam engine | deferred-feature | — |
| [#13](https://github.com/oblien/openship/issues/13) | Feature request: Allow the deployer to run separately from the control plane | deferred-feature | — |

## Reviewed bug findings

### #879: fixed-in-branch

The reporter supplied missing static deployment details after the prior review. Main still skipped its project root route because the static site lives inside an nginx container. Root routes now resolve the recorded primary service and its live port through the existing proxy and ownership checks. Host artifacts remain directory-validated; filesystem subpaths are not silently replaced by proxy roots. Earlier self-app ownership and diagnostics fixes are already in main via #891.

Commits: [`25ee2392`](https://github.com/oblien/openship/commit/25ee23928bb50200ddb2004f3f150c25a882ae12).

Verification: 112 route, upstream and ownership cases pass, including 11 new static-container cases. Five new expectations fail against main, including the reported free/custom root routes. API TypeScript passes.

### #878: needs-reproduction

Image-only Compose services already bypass source builds; the regression coverage added in #891 is now in main. No reply supplies the effective Compose/override or deployment log needed to reproduce the report.

Verification: Rechecked against main 4e66349c and all issue comments after #891 merged.

### #876: needs-reproduction

Amavis restart PID cleanup from contributor PR #885 is now in main via #891. The reported fresh-install mail deferral still needs its actual queue reason and daemon log; no follow-up diagnostics supplied.

Verification: Rechecked against main 4e66349c and all issue comments after #891 merged.

### #873: partial-main

Main now rejects empty explicit monorepo creation, detects duplicate/unmatched overrides, and documents scanner-backed workspace import. Declaring independent same-root processes without Docker is a separate capability; keep the issue open for that remainder.

Verification: Rechecked against main 4e66349c and all issue comments after #891 merged.

### #872: needs-reproduction

Main reloads encrypted credentials after cache expiry and keeps GitHub rate limits retryable, with bounded verification requests. No diagnostic follow-up establishes a remaining intermittent rejection.

Verification: Rechecked against main 4e66349c and all issue comments after #891 merged.

### #869: partial-main

Main fixes release packaging and PGlite asset resolution and refuses the incomplete remote migration shortcut before mutation. Automated remote cutover remains an unimplemented workflow, outside this bug-only batch.

Verification: Rechecked against main 4e66349c and all issue comments after #891 merged.

### #773: needs-reproduction

Current SSH discovery retains bounded streamlocal verification and dial-stdio fallback. No follow-up identifies the stalled request behind the reported timeout; increasing global timeouts is not a justified fix.

Verification: Rechecked against main 4e66349c and all issue comments after #891 merged.

### #695: needs-reproduction

The report has no bug description, version, or reproduction steps; no response to the earlier diagnostic request.

Verification: Rechecked against main 4e66349c and all issue comments after #891 merged.

### #668: partial-branch

Reproduced stale-target reconnects, late terminal events overwriting a new connection, stale log status, and replaced log streams disconnecting their successor. Connections now have explicit ownership and cleanup; shell and log handshakes fail visibly after 60 seconds. Build streaming retains stable disconnect controls. The report contains no version, target or latency trace, so unspecified backend slowness remains unverified and the issue stays open.

Commits: [`30c564b0`](https://github.com/oblien/openship/commit/30c564b0ed741246e3e75195de9e0f97ddc556a4).

Verification: 17 React lifecycle and real ReadableStream cases pass; 12 reproduced failures on main. Dashboard TypeScript passes.

### #661: fixed-in-branch

Confirmed duplicate release/changelog/advisory requests between native startup and dashboard consumers, plus overlapping web refreshes. The desktop process now shares and caches one typed snapshot; the renderer uses its IPC result and concurrent manual checks join the active request. Shared core installer types replace duplicate local definitions. Successful checks clear obsolete offers; offline failures do not invalidate a staged installer.

Commits: [`829b811a`](https://github.com/oblien/openship/commit/829b811ae48ed85a27f494f4730541ad892eb7dc).

Verification: Seven new native/React regressions fail on main. Fourteen update and IPC cases pass after the change; desktop and dashboard TypeScript pass.

### #660: fixed-in-branch

Background fleet updates and durable queued/running progress were already in main. The remaining page behavior now uses the existing prepare stream component inline for log viewing, individual fixes and install recovery. Read-only log reconnects remain GETs; switching/dismissing releases the old reader and ignores late results. Shared consent and outcome logic is retained.

Commits: [`e3cb57ec`](https://github.com/oblien/openship/commit/e3cb57eca01c9fe711301526642d84377305149a).

Verification: Eight React/SSE cases fail on main and pass with the change; 27 page, fleet and outcome cases and dashboard TypeScript pass. Reviewed the shared backend to confirm accepted container updates outlive observers.

### #659: already-fixed-main

The shared issue feed uses open server_unreachable incidents to suppress cached edge/mail absence, down and update rows for that server. HTTP/native readers share this aggregator; no duplicate detector or patch is needed.

Commits: [`4e66349c`](https://github.com/oblien/openship/commit/4e66349c27b48df13697c1b6d4a95f7a6cf4a3d6).

Verification: 78 issue aggregation/container-state tests pass, including suppression of component warnings for an unreachable server.

### #658: already-fixed-main

Reviewed the shared teardown and resource manifest on main: writer locking and confirmed quiescence precede cleanup; cleanup phases respect container/data/network dependencies; port claims release only after successful workload/route cleanup. Reachable failures retain the project, and deferred cleanup must be recorded before its row can disappear. Data intentionally retained by the default volume policy or explicit record-only mode is not an untracked leak.

Commits: [`4e66349c`](https://github.com/oblien/openship/commit/4e66349c27b48df13697c1b6d4a95f7a6cf4a3d6).

Verification: 60 existing teardown, resource-shape, controller and restore-cancellation cases pass.

### #638: fixed-in-branch

Reproduced immediate deletion on main. Adapted contributor PR #639, preserving its original commit and GitHub merge credit. The existing confirmation dialog now gates the page deletion handler, with cancellation, keyboard access, focus restoration and pending-request protection.

Commits: [`c4e730e6`](https://github.com/oblien/openship/commit/c4e730e61374119caad4e4a35d9370a8463e3943).

Verification: Five real DOM interaction regressions fail on main and pass after the fix; dashboard TypeScript passes.

### #610: partial-branch

Replaced the misleading blanket Apache claim with a component and artifact inventory. iRedMail is GPL-licensed and is copied into API/mail containers, CLI payloads and desktop resources even when mail is unused. No component is relicensed. The vendored Zero Email provenance/notices still need a separate review, so the issue remains open.

Commits: [`93d2349b`](https://github.com/oblien/openship/commit/93d2349b1027773b1888dab948b77869d307e823).

Verification: Read the existing licenses/file notices and traced API, CLI, desktop, mail and standalone release packaging scripts.

### #608: fixed-in-branch

Main produces invalid JSON on an actual Mac. Adapted contributor PR #645 into the shared adapter/platform path, preserving its history and GitHub merge credit. One portable command returns consistent memory fields and interval CPU samples, handles Intel/ARM page sizes, and fails incomplete probes. Compared #888; closing the overlapping later PR after integrating the earlier fix.

Commits: [`5bde4848`](https://github.com/oblien/openship/commit/5bde484890beb362925c870dec603efe9fde4e79).

Verification: 7 command execution tests pass: macOS fixtures, Linux CPU accounting, large disks, failed/unsupported probes and actual macOS sh/zsh samples. All 22 workspace build/typecheck tasks pass.

### #568: already-fixed-main

Both substantive requests are already implemented: stored site title/description reach HTML and OpenGraph and survive hydration, and PATCH /admin/branding accepts showPoweredBy=false to hide the vendor/footer-link row. The login client honors that flag. Extra logo-upload/footer-customization capabilities are not added.

Commits: [`4e66349c`](https://github.com/oblien/openship/commit/4e66349c27b48df13697c1b6d4a95f7a6cf4a3d6).

Verification: 10 branding HTML/hydration cases pass, plus direct inspection of the schema and rendered login footer.

### #501: fixed-in-branch

Confirmed missing Composer assets in main. Adapted and merged contributor PR #467 with original history and merge credit. The Node stage reuses the installed builder workspace, covering custom dependency paths and monorepos without duplicate source copies or assuming vendor always exists.

Commits: [`d8dbf53c`](https://github.com/oblien/openship/commit/d8dbf53c979ec2994f76fae6c511d23f05232be9).

Verification: 33 recipe tests, API TypeScript, and two real Docker builds of the generated asset stage pass. Both Docker regressions fail with the main recipe. Fixture supplies Composer output; it does not compile PHP extensions.

### #500: already-fixed-main

Both onFailure and onCancelled call cleanupOwnedServiceContainers. It uses the shared retained-resource keep set, excludes the failed attempt, preserves serving containers, and keeps every container if ownership cannot be resolved. PR #517 would duplicate the existing main fix.

Commits: [`4e66349c`](https://github.com/oblien/openship/commit/4e66349c27b48df13697c1b6d4a95f7a6cf4a3d6).

Verification: 20 lifecycle, retained-resource and reject-manifest tests pass; the same cleanup owner serves failure and cancellation.

### #426: fixed-in-branch

Confirmed orphan sessions when a browser disconnects during shell/audit setup. Adapted and merged contributor PR #579, preserving original authorship and GitHub merge credit. Also made unaudited IDs collision-free and closed service-runtime leases on rejected or failed handshakes. Established sessions still park for reconnect.

Commits: [`380d2526`](https://github.com/oblien/openship/commit/380d25260649cf8eb590854d7833c5ca3dea037e).

Verification: 15 behavioral regressions plus six existing registry cases pass; 11 of the new cases fail against main. API TypeScript passes.

### #410: already-fixed-main

DeploymentMenu uses the shared row type and canRequestRestorePlan, which accepts the mapped success status and delegates eligibility to the restore planner. The old ready-versus-success comparison is gone. PR #542 requests the separate bisect feature and remains deferred.

Commits: [`4e66349c`](https://github.com/oblien/openship/commit/4e66349c27b48df13697c1b6d4a95f7a6cf4a3d6).

Verification: Three restore UI tests pass; reviewed mapping and the actual menu caller on main.

Feature requests and their PRs stay open. Reproduction gaps stay open with a concrete diagnostic request. Issues fixed on this branch are closed with a comment identifying #892 and the pending merge to main.
