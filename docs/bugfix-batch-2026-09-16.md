# Bug review batch — 2026-09-16

Base: `4e66349c27b48df13697c1b6d4a95f7a6cf4a3d6` (`main`, including merged PR #891).

Integration: [PR #892](https://github.com/oblien/openship/pull/892), branch `feat/bugfix-batch-2026-09-16`. Review every currently open report from newest to oldest, including unresolved reports from the previous review and their follow-up comments. This supersedes the initial selection of 50 previously unreviewed reports. New capabilities remain outside this bug-fix batch.

The previous integration worktree and old branches, including `ship`, were removed after verifying their tips are in main. User changes on main are preserved. Adaptable contributor PRs are edited and merged into this branch with their original history and GitHub merge credit.

## Progress

16 already-fixed-main; 57 deferred-feature; 23 fixed-in-branch; 4 needs-reproduction; 4 partial-branch; 4 partial-main. Every report has completed this review pass. Partial and reproduction-dependent reports remain open. Nothing in this branch has been merged into main.

## Issue ledger

| Issue | Report | Status | Linked PRs |
| --- | --- | --- | --- |
| [#894](https://github.com/oblien/openship/issues/894) | feat(webmail): refresh the inbox when new mail arrives | deferred-feature | — |
| [#893](https://github.com/oblien/openship/issues/893) | Compose-mode: env var update never reaches container once its compose-referenced value is cached (reconcileFromCompose bootstrap lock-in) | fixed-in-branch | — |
| [#879](https://github.com/oblien/openship/issues/879) | [Bug]: [0.7.2] Custom domains at project level are verified + certified but never routed locally; self-app domain cannot converge (host-port claim conflict) | fixed-in-branch | — |
| [#878](https://github.com/oblien/openship/issues/878) | [Improvement]: Deployments don't use external repository and rebuild images instead | needs-reproduction | — |
| [#877](https://github.com/oblien/openship/issues/877) | [Feature]: Add Porkbun as a supported DNS Provider | deferred-feature | — |
| [#876](https://github.com/oblien/openship/issues/876) | [Bug]: Email service is waiting for emails to go out forever | needs-reproduction | [#885](https://github.com/oblien/openship/pull/885) |
| [#873](https://github.com/oblien/openship/issues/873) | [Bug]: `openship.json`'s `monorepo` config (and CLI `project create --type monorepo`) is documented and schema-valid, but doesn't actually produce a multi-app project through any available path | already-fixed-main | — |
| [#872](https://github.com/oblien/openship/issues/872) | [Bug]: Global GitHub device-flow connection intermittently shows "rejected".  The status is backed by a Redis cache entry with a ~100 second TTL, not the actual GitHub authorization state | already-fixed-main | — |
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
| [#668](https://github.com/oblien/openship/issues/668) | Services logs hang out / takes too much time to show logs, terminal not load with silent fail in desktop | fixed-in-branch | — |
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
| [#556](https://github.com/oblien/openship/issues/556) | Upstream-down hostnames return a raw OpenResty 502 instead of a friendly “Application unavailable” page | fixed-in-branch | [#557](https://github.com/oblien/openship/pull/557) |
| [#541](https://github.com/oblien/openship/issues/541) | feat(cli): `openship deployment bisect` — binary-search deployment history for the first bad deploy | deferred-feature | [#542](https://github.com/oblien/openship/pull/542) |
| [#535](https://github.com/oblien/openship/issues/535) | [Feature] Support buildStrategy: "local" for Docker stacks — build the image on the control-plane host and ship it to the target server | deferred-feature | — |
| [#530](https://github.com/oblien/openship/issues/530) | feat: enable the Uptime Kuma app template | deferred-feature | [#531](https://github.com/oblien/openship/pull/531) |
| [#527](https://github.com/oblien/openship/issues/527) | Experience as first time / new user | partial-main | — |
| [#521](https://github.com/oblien/openship/issues/521) | RFC: External installable plugin architecture (versioned outside core) | deferred-feature | — |
| [#513](https://github.com/oblien/openship/issues/513) | Add Kan.bn to the apps catalog | deferred-feature | [#522](https://github.com/oblien/openship/pull/522), [#534](https://github.com/oblien/openship/pull/534) |
| [#512](https://github.com/oblien/openship/issues/512) | Add Shoutrrr to the apps catalog | deferred-feature | [#526](https://github.com/oblien/openship/pull/526), [#534](https://github.com/oblien/openship/pull/534) |
| [#509](https://github.com/oblien/openship/issues/509) | Docker app deployment fails because the host channel is not provisioned | already-fixed-main | [#518](https://github.com/oblien/openship/pull/518) |
| [#506](https://github.com/oblien/openship/issues/506) | [Bug] Same-server migration leaves app unreachable — "Auto" routing mode doesn't publish a loopback port | fixed-in-branch | [#499](https://github.com/oblien/openship/pull/499), [#508](https://github.com/oblien/openship/pull/508) |
| [#505](https://github.com/oblien/openship/issues/505) | [Feature] Allow dismissing/ignoring an issue (edge_absent et al.) — or a per-server component opt-out | deferred-feature | — |
| [#504](https://github.com/oblien/openship/issues/504) | ConnectionCard is hidden for non-catalog projects — "Use in a project" is unreachable for single-app/compose/monorepo sources | fixed-in-branch | [#507](https://github.com/oblien/openship/pull/507) |
| [#501](https://github.com/oblien/openship/issues/501) | Laravel asset build fails when a package ships CSS from vendor/ (Livewire Flux, Filament) — the asset stage has no vendor/ | fixed-in-branch | [#467](https://github.com/oblien/openship/pull/467) |
| [#500](https://github.com/oblien/openship/issues/500) | `onFailure` destroys carried-forward (still-live) containers when a compose deploy fails — a failed redeploy can take down the running app | already-fixed-main | [#517](https://github.com/oblien/openship/pull/517) |
| [#495](https://github.com/oblien/openship/issues/495) | [Feature]: MFA for server accounts | deferred-feature | [#772](https://github.com/oblien/openship/pull/772) |
| [#488](https://github.com/oblien/openship/issues/488) | up dry-run reports POSTGRES_PASSWORD=<preserved> but writes a newly generated password | fixed-in-branch | [#496](https://github.com/oblien/openship/pull/496) |
| [#487](https://github.com/oblien/openship/issues/487) | OPENSHIP_PGDATA detection picks the volume root when re-installing over an existing pgdata/ subdirectory | fixed-in-branch | [#494](https://github.com/oblien/openship/pull/494) |
| [#483](https://github.com/oblien/openship/issues/483) | add X as a notification delivery channel | deferred-feature | — |
| [#433](https://github.com/oblien/openship/issues/433) | 🔄 Request: More Frequent `dev` Branch Updates + Release Channel Switcher | deferred-feature | — |
| [#429](https://github.com/oblien/openship/issues/429) | [Bug + Feature Request] Deleted emails stuck with TRASH label & no auto-refresh on new email | fixed-in-branch | [#430](https://github.com/oblien/openship/pull/430), [#478](https://github.com/oblien/openship/pull/478) |
| [#428](https://github.com/oblien/openship/issues/428) | Feature Request: Show a friendly "Service Not Found" page for unrecognized hostnames instead of raw SSL/TLS errors | deferred-feature | — |
| [#426](https://github.com/oblien/openship/issues/426) | [Bug] Terminal session counter not reset after browser disconnect — ghost sessions block new shells indefinitely | fixed-in-branch | [#432](https://github.com/oblien/openship/pull/432), [#579](https://github.com/oblien/openship/pull/579) |
| [#424](https://github.com/oblien/openship/issues/424) | How to change the binding IP address of container? | already-fixed-main | — |
| [#417](https://github.com/oblien/openship/issues/417) | Support Cloudflare Email Sending in self-hosted SMTP settings | deferred-feature | — |
| [#415](https://github.com/oblien/openship/issues/415) | Add OpenTelemetry Collector to the apps catalog | deferred-feature | [#416](https://github.com/oblien/openship/pull/416), [#534](https://github.com/oblien/openship/pull/534) |
| [#411](https://github.com/oblien/openship/issues/411) | [Feature Request] Allow login with username only (without @domain) on single-domain setup | deferred-feature | — |
| [#410](https://github.com/oblien/openship/issues/410) | Rollback action permanently disabled on every deployment — status string mismatch ("ready" vs "success") | already-fixed-main | [#542](https://github.com/oblien/openship/pull/542) |
| [#408](https://github.com/oblien/openship/issues/408) | Docker health check shows Unhealthy on external server added via SSH (password auth) despite Docker running normally | fixed-in-branch | [#422](https://github.com/oblien/openship/pull/422) |
| [#402](https://github.com/oblien/openship/issues/402) | Add a standalone PostgreSQL app to Install App or make database services easier to find | deferred-feature | [#405](https://github.com/oblien/openship/pull/405) |
| [#401](https://github.com/oblien/openship/issues/401) | Add SeaweedFS as an Install App option for self-hosted object storage | deferred-feature | [#406](https://github.com/oblien/openship/pull/406) |
| [#399](https://github.com/oblien/openship/issues/399) | Add a standalone PostgreSQL app to Install App or make database services easier to find | deferred-feature | — |
| [#398](https://github.com/oblien/openship/issues/398) | Add SeaweedFS as an Install App option for self-hosted object storage | deferred-feature | — |
| [#397](https://github.com/oblien/openship/issues/397) | Add TanStack Start support to framework detection and project setup | deferred-feature | — |
| [#396](https://github.com/oblien/openship/issues/396) | Overview page shows 0 requests / no traffic data on some projects (silent AbortError in root layout) | fixed-in-branch | [#421](https://github.com/oblien/openship/pull/421) |
| [#392](https://github.com/oblien/openship/issues/392) | [Bug] smtp_tls_security_level set to "encrypt" breaks inbound mail delivery via Amavis | fixed-in-branch | [#423](https://github.com/oblien/openship/pull/423), [#477](https://github.com/oblien/openship/pull/477) |
| [#391](https://github.com/oblien/openship/issues/391) | [Bug] Relay SMTP settings not applied to webmail container + logout redirects to 404 | partial-main | [#420](https://github.com/oblien/openship/pull/420), [#476](https://github.com/oblien/openship/pull/476) |
| [#390](https://github.com/oblien/openship/issues/390) | Bug: Latest version broke the cli | already-fixed-main | — |
| [#388](https://github.com/oblien/openship/issues/388) | Migrating coolify to openship issues | already-fixed-main | — |
| [#382](https://github.com/oblien/openship/issues/382) | [Feature]: First-class Forgejo/Gitea/Gogs integration | deferred-feature | — |
| [#381](https://github.com/oblien/openship/issues/381) | Openship Windows Path Bug | already-fixed-main | [#425](https://github.com/oblien/openship/pull/425) |
| [#379](https://github.com/oblien/openship/issues/379) | Help Wanted: Replace GitHub-Only Integration with Multi-Git Provider Support | deferred-feature | [#386](https://github.com/oblien/openship/pull/386) |
| [#378](https://github.com/oblien/openship/issues/378) | How to deploy Static HTML? | already-fixed-main | — |
| [#316](https://github.com/oblien/openship/issues/316) | Docker Swarm stack-native deployment support | deferred-feature | [#317](https://github.com/oblien/openship/pull/317) |
| [#309](https://github.com/oblien/openship/issues/309) | feat/bug: Laravel deployment issues – Service stuck in Stopped state, orphan container, missing database linking, web terminal/CLI & volume persistence | partial-main | [#469](https://github.com/oblien/openship/pull/469) |
| [#282](https://github.com/oblien/openship/issues/282) | I can't verify my custom domain - whole flow is a bit complicated, needs a bit of UX improvement as well. | already-fixed-main | — |
| [#278](https://github.com/oblien/openship/issues/278) | I could not find where I could change project name. | fixed-in-branch | [#313](https://github.com/oblien/openship/pull/313) |
| [#264](https://github.com/oblien/openship/issues/264) | Email encryption at rest using OpenPGP | deferred-feature | — |
| [#261](https://github.com/oblien/openship/issues/261) | Shell shebang should respect the correct machine setup | already-fixed-main | — |
| [#258](https://github.com/oblien/openship/issues/258) | Am i have to use github? which is public.. a bit not trusted... they sometime leak something... | deferred-feature | — |
| [#256](https://github.com/oblien/openship/issues/256) | Support ACME External Account Binding (EAB / HMAC) for certificate issuance | deferred-feature | [#1](https://github.com/oblien/openship/pull/1), [#2](https://github.com/oblien/openship/pull/2), [#3](https://github.com/oblien/openship/pull/3), [#4](https://github.com/oblien/openship/pull/4), [#5](https://github.com/oblien/openship/pull/5), [#380](https://github.com/oblien/openship/pull/380) |
| [#240](https://github.com/oblien/openship/issues/240) | [Bug] Mail health check: three false positives (SpamAssassin daemon, desktop-resolver DNS scan, DKIM baseline) | already-fixed-main | [#319](https://github.com/oblien/openship/pull/319) |
| [#231](https://github.com/oblien/openship/issues/231) | Discussion: multi-process apps and the single-start-command model (Laravel as the case study) | partial-branch | [#468](https://github.com/oblien/openship/pull/468), [#469](https://github.com/oblien/openship/pull/469), [#592](https://github.com/oblien/openship/pull/592) |
| [#220](https://github.com/oblien/openship/issues/220) | Webmail: CSS url()/@import bypasses remote-image blocking, leaking a read receipt with images off | fixed-in-branch | [#219](https://github.com/oblien/openship/pull/219), [#222](https://github.com/oblien/openship/pull/222) |
| [#216](https://github.com/oblien/openship/issues/216) | Help: Heavy tests needed for the stable release | partial-branch | [#193](https://github.com/oblien/openship/pull/193), [#219](https://github.com/oblien/openship/pull/219), [#224](https://github.com/oblien/openship/pull/224), [#243](https://github.com/oblien/openship/pull/243), [#247](https://github.com/oblien/openship/pull/247), [#248](https://github.com/oblien/openship/pull/248) |
| [#197](https://github.com/oblien/openship/issues/197) | Feature request: Telegram notification channel | deferred-feature | — |
| [#195](https://github.com/oblien/openship/issues/195) | Preview deploy overwrites the production active-deployment pointer | fixed-in-branch | [#196](https://github.com/oblien/openship/pull/196) |
| [#192](https://github.com/oblien/openship/issues/192) | Publish changelog entries in GitHub Release descriptions | fixed-in-branch | [#591](https://github.com/oblien/openship/pull/591) |
| [#188](https://github.com/oblien/openship/issues/188) | Feature Request: Native Object Storage Support | deferred-feature | — |
| [#163](https://github.com/oblien/openship/issues/163) | Clarification needed: Multi-node clustering storage and volume handling strategy | deferred-feature | — |
| [#159](https://github.com/oblien/openship/issues/159) | Feature Request: Resend Mail Integration | deferred-feature | — |
| [#148](https://github.com/oblien/openship/issues/148) | Help us Keep OpenShip more secure : | partial-branch | [#152](https://github.com/oblien/openship/pull/152), [#193](https://github.com/oblien/openship/pull/193), [#224](https://github.com/oblien/openship/pull/224) |
| [#137](https://github.com/oblien/openship/issues/137) | Feature Request: seperating email flow and module into dedicated install | deferred-feature | [#141](https://github.com/oblien/openship/pull/141) |
| [#123](https://github.com/oblien/openship/issues/123) | Global rate-limiter always applies default-anon, and double-charges routes that set their own policy | fixed-in-branch | [#232](https://github.com/oblien/openship/pull/232) |
| [#92](https://github.com/oblien/openship/issues/92) | [Feature]: Canvas feature | deferred-feature | [#600](https://github.com/oblien/openship/pull/600) |
| [#75](https://github.com/oblien/openship/issues/75) | [Feature]: First-class GitLab integration (connect, push-to-deploy, MR previews) | deferred-feature | [#177](https://github.com/oblien/openship/pull/177), [#386](https://github.com/oblien/openship/pull/386), [#593](https://github.com/oblien/openship/pull/593) |
| [#72](https://github.com/oblien/openship/issues/72) | [Feature]: Allow Rspamd to replace SpamAssassin as Amavis anti-spam engine | deferred-feature | — |
| [#13](https://github.com/oblien/openship/issues/13) | Feature request: Allow the deployer to run separately from the control plane | deferred-feature | — |

## Reviewed bug findings

### #893: fixed-in-branch

Confirmed on main: cached scan-time environment values survive reconciliation after the project value changes; failed GitHub source reads also silently fall back to cached definitions.

Restored known raw expressions and untouched legacy baseline values. New inline edits/removals record internal ownership; existing service-scoped precedence and frozen rollback semantics remain intact.

Ambiguous legacy values, including rows whose baseline was already advanced, remain intact and require the existing visible Accept upstream / Keep mine review before redeployment. Code-only webhooks cannot bypass recovery. Source errors and missing Compose services fail before deployment is queued.

Follow-up audit corrected an explicit advanced:null reset regression: omitted advanced settings retain operator values, while explicit null resets them and still records Compose environment provenance. No second reconciliation path was introduced.

Commits: [`705b004d`](https://github.com/oblien/openship/commit/705b004d96ff6da062ef63ecf03099e5a8ef8c27), [`248ba220`](https://github.com/oblien/openship/commit/248ba220d677602c55348bc8998cb15524205622), [`5e8f044e`](https://github.com/oblien/openship/commit/5e8f044eaf5f9d23d0916810b4cea28aa9171046).

Verification: 59 database/reconciliation cases and 133 lifecycle/environment/rollback cases pass; 172 service/masking cases pass, plus the added internal-marker case (52-case focused rerun).

Verification: 18 new regression cases fail against main. API TypeScript check passes.

Verification: The existing explicit-reset and preservation cases pass, together with the full 327-case database and 6,221-case API suites after the ownership hardening.

Verification: Compose recovery fixtures use Partial<Service>; database TypeScript passes without changing runtime assertions.

### #879: fixed-in-branch

The reporter supplied missing static deployment details after the prior review. Main still skipped its project root route because the static site lives inside an nginx container. Root routes now resolve the recorded primary service and its live port through the existing proxy and ownership checks. Host artifacts remain directory-validated; filesystem subpaths are not silently replaced by proxy roots. Earlier self-app ownership and diagnostics fixes are already in main via #891.

Commits: [`25ee2392`](https://github.com/oblien/openship/commit/25ee23928bb50200ddb2004f3f150c25a882ae12).

Verification: 112 route, upstream and ownership cases pass, including 11 new static-container cases. Five new expectations fail against main, including the reported free/custom root routes. API TypeScript passes.

### #878: needs-reproduction

Image-only Compose services already bypass source builds; the regression coverage added in #891 is now in main. No reply supplies the effective Compose/override or deployment log needed to reproduce the report.

Verification: Rechecked against main 4e66349c and all issue comments after #891 merged.

### #876: needs-reproduction

Amavis restart PID cleanup from contributor PR #885 is already in main through #891; #892 also includes #477's persisted filter-TLS repair. These verified related defects do not establish the cause of this fresh-install report.

Re-read the live report and inspected its original screenshot: the only deferred reason shown is "temporary failure". No queue/daemon diagnostic reply supplies a current cause. Kept open and posted the current merge status plus per-message queue inspection/cancellation commands.

Verification: Rechecked against main 4e66349c and all issue comments after #891 merged.

Verification: Rechecked the original screenshot, production boot scripts, #885 real-daemon coverage and #477 real-Postfix evidence; no claim of a verified fresh-install reproduction.

### #873: already-fixed-main

Main rejects duplicate normalized monorepo override roots, reports unmatched workspace overrides, and rejects explicit monorepo creation without detected app metadata before any project/group write. Native SDK and HTTP both preserve supported two-app creation.

Closed the silent-fallback and validation bugs already merged through #891. Independent Docker-free processes sharing a source root remain a separate runtime-role capability tracked in #231; the documentation states the supported scanner-backed workflow.

Closure: https://github.com/oblien/openship/issues/873#issuecomment-5694011281

Commits: [`7841d472`](https://github.com/oblien/openship/commit/7841d47210949c5f2fe16988442d453ba4406f66).

Verification: Configuration parsing, source preparation/root discovery and native SDK/HTTP create/ensure regressions pass in the closure recheck. The linked fix is an ancestor of main and #892.

### #872: already-fixed-main

Main reloads the encrypted instance credential on cache expiry. GitHub 403 primary/secondary rate limits, 429 responses, network failures and timeouts remain retryable; actual authorization rejection still requests reconnection.

Closed the verified credential-handling defect after rechecking the implementation and its Settings/device-flow regressions. The fix landed through #891 and is inherited by #892; an additional intermittent failure requires a concrete reproduction rather than keeping the resolved defect open.

Closure: https://github.com/oblien/openship/issues/872#issuecomment-5694010013

Commits: [`2715609a`](https://github.com/oblien/openship/commit/2715609ae84060c2907a4e36cd79886093401c5f).

Verification: Rechecked main 4e66349c and #892 at 0285ccb2. Identity, device-flow and Settings-response regression suites pass, including a cold-cache retry after throttling.

### #869: partial-main

Main fixes release packaging and PGlite asset resolution and refuses the incomplete remote migration shortcut before mutation. Automated remote cutover remains an unimplemented workflow, outside this bug-only batch.

Verification: Rechecked against main 4e66349c and all issue comments after #891 merged.

### #773: needs-reproduction

Current SSH discovery retains bounded streamlocal verification and dial-stdio fallback. No follow-up identifies the stalled request behind the reported timeout; increasing global timeouts is not a justified fix.

Verification: Rechecked against main 4e66349c and all issue comments after #891 merged.

### #695: needs-reproduction

The report has no bug description, version, or reproduction steps; no response to the earlier diagnostic request.

Verification: Rechecked against main 4e66349c and all issue comments after #891 merged.

### #668: fixed-in-branch

Reproduced stale-target reconnects, late terminal events overwriting a new connection, stale log status, and replaced log streams disconnecting their successor. Connections now have explicit ownership and cleanup; shell and log handshakes fail visibly after 60 seconds. Build streaming retains stable disconnect controls.

Closed the reproduced connection bugs with the #892 fix and pending-main status. The report has no separate server-delay reproduction; a new concrete failure can be reopened rather than keeping the verified lifecycle fixes indefinitely partial.

Closure: https://github.com/oblien/openship/issues/668#issuecomment-5694012488

The final PR audit repairs build-log retry scheduling after EOF/errors and isolates replacement attempts. HTTP 401/403 stops retries; replay resumes after the highest received event ID and filters duplicates before terminal writes.

Commits: [`30c564b0`](https://github.com/oblien/openship/commit/30c564b0ed741246e3e75195de9e0f97ddc556a4), [`a57cc76b`](https://github.com/oblien/openship/commit/a57cc76b62cae1c784235476cd8ed4f53863e64f).

Verification: 17 React lifecycle and real ReadableStream cases pass; 12 reproduced failures on main. Dashboard TypeScript passes.

Verification: Closure recheck: all 17 terminal/log lifecycle cases pass again at 0285ccb2.

Verification: EOF/error and replay regressions fail before their fixes. All 104 stream/PTY/processor cases pass, including permission failures, terminal completion and stale attempt cleanup.

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

### #556: fixed-in-branch

Adapted and merged contributor PR #557 into #892 with original history and GitHub merge credit. Proxy vhosts now serve an application-unavailable page for edge-generated 502/504, preserving status and application responses. Generation 3 upgrades existing saved routes. A completely unreachable host remains a separate Cloud-edge concern, as scoped in the report.

Commits: [`90dd8681`](https://github.com/oblien/openship/commit/90dd8681034ac2c8a60acc2879156fca1a3dce88).

Verification: 200 adapter cases and six real OpenResty HTTP cases pass; three HTTP cases and the generation-2 upgrade regression fail against main. API TypeScript passes.

### #527: partial-main

Re-read all follow-ups, including Docker 29.7.2 still unhealthy after reinstall, edge installed/absent disagreement and Ghost public URL behavior. Main now supports explicit host-channel accounts, real authentication diagnostics, direct key upload, and correct local socket/edge selection. The newer installation-specific symptoms are not proven resolved; keep open for current doctor/component errors and the affected public URL.

The confirmed stale-group failure from #408 is fixed in this branch. Whether it explains this report still requires the Docker error; the Ghost public URL report remains unresolved.

Commits: [`4e66349c`](https://github.com/oblien/openship/commit/4e66349c27b48df13697c1b6d4a95f7a6cf4a3d6).

Verification: 47 existing adapter/API component, local-target and host-channel cases pass; this is not a reproduction of the reporter’s server.

### #509: already-fixed-main

Main already provisions and preserves the host channel, reports key generation/authentication failures, probes from the API container, and exposes the same diagnosis in doctor. Environment changes force recreation after prefetch. Local compose targets use the Docker socket/shared edge without treating the pooled host executor as a remote box. PR #518 adds a weaker file-presence check and duplicates these implemented paths.

Commits: [`4e66349c`](https://github.com/oblien/openship/commit/4e66349c27b48df13697c1b6d4a95f7a6cf4a3d6).

Verification: 188 existing CLI configuration/host-channel cases and 47 adapter/API target, component and channel cases pass. Reviewed the localHost and OPENSHIP_EDGE_MODE wiring and repair documentation.

### #506: fixed-in-branch

The primary routing fix is already on main: missing live loopback bindings fall back to the observed container IP, and adopted project routes select the service owning the requested port. Removed the remaining misleading project.port fallback from service-based Overview pages; those ports are owned and displayed per service. No duplicate routing resolver was introduced.

Commits: [`ba9b8085`](https://github.com/oblien/openship/commit/ba9b8085375d2f8886886a534c842534a56f0ed2).

Verification: Reviewed shared upstream selection and adopted-route regressions (part of the 112 passing route/upstream/ownership cases). Existing Overview React cases pass after the display correction.

### #504: fixed-in-branch

Reopened and adapted contributor PR #507, then merged it into #892 with its original history and GitHub credit. Non-catalog self-hosted projects now reach the existing connection flow from Overview. The same API decides reachable outputs, including attached services on static parents; empty outputs stay hidden and synthesized internal addresses are not offered for cloud projects.

Commits: [`74fe1521`](https://github.com/oblien/openship/commit/74fe15218151275399ea684186402276286d7639).

Verification: Five real React connection-discovery cases pass; three fail on main. Dashboard TypeScript passes.

### #501: fixed-in-branch

Confirmed missing Composer assets in main. Adapted and merged contributor PR #467 with original history and merge credit. The Node stage reuses the installed builder workspace, covering custom dependency paths and monorepos without duplicate source copies or assuming vendor always exists.

Commits: [`d8dbf53c`](https://github.com/oblien/openship/commit/d8dbf53c979ec2994f76fae6c511d23f05232be9).

Verification: 33 recipe tests, API TypeScript, and two real Docker builds of the generated asset stage pass. Both Docker regressions fail with the main recipe. Fixture supplies Composer output; it does not compile PHP extensions.

### #500: already-fixed-main

Both onFailure and onCancelled call cleanupOwnedServiceContainers. It uses the shared retained-resource keep set, excludes the failed attempt, preserves serving containers, and keeps every container if ownership cannot be resolved. PR #517 would duplicate the existing main fix.

Commits: [`4e66349c`](https://github.com/oblien/openship/commit/4e66349c27b48df13697c1b6d4a95f7a6cf4a3d6).

Verification: 20 lifecycle, retained-resource and reject-manifest tests pass; the same cleanup owner serves failure and cancellation.

### #488: fixed-in-branch

Main already preserves parsed secrets and writes .env atomically. Closed the remaining safety gap: Docker inspection failures are not treated as proof that no database exists, and the final writer revalidates missing-secret risk before minting configuration. The preview uses the same resolved input as the writer.

Commits: [`49c580fe`](https://github.com/oblien/openship/commit/49c580fecb21e8d045afe5f759b65b5ec6caa203).

Verification: 153 CLI storage/configuration cases and CLI TypeScript pass. Seven cases fail on main. The actual read-only Docker probe correctly distinguishes root, subdirectory, empty, lost+found-only, foreign and unavailable-daemon cases; temporary volumes were removed.

### #487: fixed-in-branch

Main already detects root/subdirectory clusters, but failed probes still guessed pgdata/ and prefetch could bypass the refusal. The shared resolver now has an explicit unresolved result; preview, prefetch and the final writer refuse unknown or foreign layouts before changing configuration. Pinned paths remain unchanged.

Commits: [`49c580fe`](https://github.com/oblien/openship/commit/49c580fecb21e8d045afe5f759b65b5ec6caa203).

Verification: 153 CLI storage/configuration cases and CLI TypeScript pass. Seven cases fail on main. The actual read-only Docker probe correctly distinguishes root, subdirectory, empty, lost+found-only, foreign and unavailable-daemon cases; temporary volumes were removed.

### #429: fixed-in-branch

Deletion fixed by contributor PR #430, adapted and merged into #892 with actual GitHub merge credit. All delete entry points preserve the source mailbox and use the existing IMAP delete handler. Closed overlapping PR #478 with the reason.

Closed the verified deletion bug, waiting for #892 to merge into main. The separate automatic inbox-refresh feature is preserved in open issue #894, attributed to its original request in #429.

Closure: https://github.com/oblien/openship/issues/429#issuecomment-5694066964

Commits: [`5dbd9b2b`](https://github.com/oblien/openship/commit/5dbd9b2b1455739791d4533a2921f0de676e8201).

Verification: 4 client-to-tRPC-to-IMAP regressions pass; 3 fail on main. All 64 mail server tests, server TypeScript and mail client production build pass. IMAP transport is substituted in the regressions.

Verification: Closure recheck: all four client-to-tRPC-to-IMAP deletion cases pass again.

### #426: fixed-in-branch

Confirmed orphan sessions when a browser disconnects during shell/audit setup. Adapted and merged contributor PR #579, preserving original authorship and GitHub merge credit. Also made unaudited IDs collision-free and closed service-runtime leases on rejected or failed handshakes. Established sessions still park for reconnect.

The final PR code audit also binds resumed sessions to the server/service authorized by the current handshake. A token from another target is rejected without consuming or closing its parked shell.

Commits: [`380d2526`](https://github.com/oblien/openship/commit/380d25260649cf8eb590854d7833c5ca3dea037e), [`dacf2b0e`](https://github.com/oblien/openship/commit/dacf2b0efef713076d0404f42cd55d379ae945b6).

Verification: 15 behavioral regressions plus six existing registry cases pass; 11 of the new cases fail against main. API TypeScript passes.

Verification: Both cross-target resume cases fail on the reviewed PR head. Same-target resumes and all 116 focused terminal/restore cases pass after hardening.

### #424: already-fixed-main

Configuration question: explicit service/Compose host-interface port mappings already support LAN IP:port access. Answered with the current Networking Ports setting and 0.0.0.0:8080:5173 example; the managed classic-app loopback default stays intentional.

Verification: Traced service editor, service deployment input and shared Docker parsePortBindings; explicit host interfaces are preserved.

### #410: already-fixed-main

DeploymentMenu uses the shared row type and canRequestRestorePlan, which accepts the mapped success status and delegates eligibility to the restore planner. The old ready-versus-success comparison is gone. PR #542 requests the separate bisect feature and remains deferred.

Commits: [`4e66349c`](https://github.com/oblien/openship/commit/4e66349c27b48df13697c1b6d4a95f7a6cf4a3d6).

Verification: Three restore UI tests pass; reviewed mapping and the actual menu caller on main.

### #408: fixed-in-branch

Follow-up confirmed stale SSH supplementary groups after usermod. Re-check refreshes the shared pool only on a Docker permission refusal with changed account groups; subsequent operations use the new login. Active commands and retained terminals survive, retired transports are disposed, and unknown or unchanged permissions remain failures. Closed PR #422 because switching the probe command cannot fix this.

Commits: [`a435f5c9`](https://github.com/oblien/openship/commit/a435f5c90aa895bc2d5c031092f2f2609926f2a5).

Verification: 53 API/pool/authorization and 15 Docker diagnostic cases pass; API TypeScript passes. Three handler cases fail on main. A real SSH fixture verified old-session denial, refreshed-session access and retained-session survival using a group-protected probe; temporary container removed.

### #396: fixed-in-branch

Confirmed on main, including the follow-up comment: Overview sent an expensive domainless request before the domain effect, silently displayed empty traffic after timeouts, and invalidated requests could overwrite newer cached data.

Adapted and merged contributor PR #421 into the integration branch with its original history and GitHub merge credit. Shared retry UI preserves independent resource/geo panels; render-time selection prevents unscoped and cross-project requests; cache and polling reject stale responses.

Commits: [`0834b84c`](https://github.com/oblien/openship/commit/0834b84ce52dc0eaa9bbc73337e055e7bf94408a).

Verification: 99 relevant dashboard cases (98-case suite plus the added polling regression) pass. Ten new cases fail against main. Dashboard TypeScript check passes.

### #392: fixed-in-branch

Main already exempted the Amavis transport TLS level, but implicit relay TLS still disabled the filter and switching 465 to 587 left wrapper mode enabled. Persisted config also missed image-default repairs until a relay was resaved.

Adapted and merged contributor PR #477 with original history and GitHub merge credit, retaining required external relay encryption. Both legacy and container relay updates repair Amavis before changing credentials and fail visibly on repair errors; image boot repairs persistent master.cf too.

Commits: [`da951633`](https://github.com/oblien/openship/commit/da951633373c139e0edbcef2ba14e82568914032).

Verification: 62 mail regression cases pass; four new cases fail against main. API TypeScript and mail shell syntax checks pass.

Verification: Real Debian Postfix reproduced the main implicit-TLS/Amavis deferral, delivered the queued message after the production repair, verified idempotence, and refused plaintext delivery to a relay without STARTTLS. The isolated test container was removed.

### #391: partial-main

Current main has same-origin webmail authentication and explicit /login route guards; the undefined redirect is no longer present.

Managed webmail intentionally submits to its own Postfix on 465, which then uses the configured external relay. The original network timeout still needs current Mail Health/Test diagnostics; issue stays open.

PR #476 was closed as superseded/incompatible: its obsolete redirect path is gone and a universal loopback mail backend breaks separate container/server deployments.

Verification: 6 split-delivery, reachability, and client-origin regression cases pass.

### #390: already-fixed-main

Reviewed the complete report and follow-ups. Current main uses a Node-based official installer: a system Node >=22 or a private vendored Node, with a stable launcher and removal of the old Bun-global command. The npm bin remains a Node wrapper for correct Windows launchers; its engine requirement matches the public package.

This resolves the reported installer/runtime mismatch and avoids the Bun cpu-features/libuv crash path for the supported installation. It does not claim upstream Bun native-addon compatibility is fixed.

Verification: Built and installed the actual public package outside the workspace under Node 22.21.1: ESM/CJS, NodeNext declarations, passive imports, native deployment and persistence, tenant isolation/revocation, cleanup, npm command resolution and CLI help/version all pass. Compared the installer/runtime source with main.

### #388: already-fixed-main

Current main imports foreign stacks as services projects, preserves stack-qualified identities, removes pinned host ports, and keeps internal container ports for routing. Imported services no longer collide with Openship Postgres or each other through their old host bindings.

Domains & Routes exposes each imported service/port separately. Configure Convex backend HTTP and site endpoints on their actual container ports and the dashboard on its own endpoint. Host exposure changes are explicit migration warnings.

Verification: 82 migration, Docker-inspection, preparation, and static-recipe cases pass. Verified the relevant migration and routing implementation already exists in main; this is not a claim of running a full live Coolify migration.

### #381: already-fixed-main

Main already uses POSIX remote nginx/certbot paths, validates the actual certificate/key, reads certificate expiry, persists it for renewal, and does not infer failure from certbot donation text.

Issue closed with update/retry guidance for old domain records; linked PR #425 was already closed.

Verification: 17 Windows-path and certbot-diagnostic regression cases pass.

### #378: already-fixed-main

The reported packageManager=unknown validation error is fixed in main: preparation normalizes an undetected package manager before returning the public configuration. Static Site detects index.html and defaults to output directory . with no build/start command.

Provided a minimal repository/import walkthrough. The separate Docker static root-routing defect is fixed by #879 in this branch.

Verification: 82 preparation, static-recipe, and migration cases pass, including no-manifest package-manager normalization.

### #309: partial-main

The current app-row reconciler keeps the source-built app when sidecars are added, inherits project build/env/storage settings, and repairs only recognized never-successful phantom rows. Live service state is resolved from the host using labels/names/tracked IDs instead of stale deployment status.

Terminal and persistent-volume controls now exist. SQLite still requires an initialized database on a persisted path (for example under /app/storage) or an external database; automatic migrations/process roles are separate feature work.

The old project/container mismatch in this report cannot be certified repaired without current project/service/deployment metadata. Left open for a current reproduction rather than guessing which legacy container to adopt.

Verification: 33 app-row reconciliation cases and 24 live-service identity/state cases pass.

Verification: Read the complete report and follow-up; traced start/provision, source recipe inheritance, live container resolution and Laravel persistence defaults.

### #282: already-fixed-main

All three follow-up defects are addressed on current main: optimistic domains never invent persisted IDs and verification waits for a real row; custom service endpoints remain authoritative through the route/Cloud gate; editable production ports update the selected endpoint and use its actual hostname in the label.

The reviewed domain components and guard are unchanged between main and this integration branch.

Verification: 18 dashboard verification/default-domain/target cases pass; current API custom-route and free-domain-guard cases pass.

Verification: Read the empty initial body and all detailed follow-up comments; reviewed service endpoint persistence and the port input change handler.

### #278: fixed-in-branch

Main already exposes display-name editing in the project menu and keeps project/group slugs, routes and volumes stable. The remaining follow-up was CLI parity.

Added project rename through the existing SDK update operation, passing only a trimmed name. Blank names are rejected before a request; backend conflicts remain authoritative. PR #313 is already closed and targets an obsolete UI location.

Commits: [`782171b6`](https://github.com/oblien/openship/commit/782171b6c8d8eea4831d6efbfc06a9fabb79b241).

Verification: 14 CLI project cases and CLI TypeScript pass, including SDK request ownership, blank-name rejection and server-conflict propagation.

Verification: Existing API rename coverage verifies immutable slugs, group-name propagation and unchanged routing.

### #261: already-fixed-main

Reviewed the complete report and follow-ups. Current main uses a Node-based official installer: a system Node >=22 or a private vendored Node, with a stable launcher and removal of the old Bun-global command. The npm bin remains a Node wrapper for correct Windows launchers; its engine requirement matches the public package.

This resolves the reported installer/runtime mismatch and avoids the Bun cpu-features/libuv crash path for the supported installation. It does not claim upstream Bun native-addon compatibility is fixed.

Verification: Built and installed the actual public package outside the workspace under Node 22.21.1: ESM/CJS, NodeNext declarations, passive imports, native deployment and persistence, tenant isolation/revocation, cleanup, npm command resolution and CLI help/version all pass. Compared the installer/runtime source with main.

### #240: already-fixed-main

Reviewed all three false positives and the installer/CLI follow-ups against current main. Standalone spamd is informational because Amavis embeds SpamAssassin; the scan queries public resolvers and reports synthetic fake-IP answers as unknown; DKIM comparison normalizes whitespace and split TXT strings.

The current installer uses the mail-engine container rather than running iRedMail.sh on the host, preserving the host firewall. Existing legacy installations are not automatically reconfigured. CLI server install-respond and server check are implemented and documented.

Verification: 69 DNS, mail-health endpoint/probe and firewall cases pass.

Verification: Reviewed the original report and closed PR #319; current main already covers its standalone-SpamAssassin correction with the current mail topology.

### #231: partial-branch

Read the complete body and follow-up discussion, including the September 16 Rails-preset request. Replied with implemented/pending-main status and confirmed that the multi-role/runtime and release-phase decision remains outside this bug batch.

Contributor PR #468 is integrated: Rails storage persistence, build/start defaults and resolved Gemfile.lock dependencies use the existing core mechanisms.

Valkey now uses the shared Redis/RDB catalog and producer, including VALKEY_PASSWORD and images providing only valkey-cli. Restore refuses unknown AOF settings, failed or oversized probes, and unconfirmed snapshot disabling before opening the artifact.

Contributor PR #469 is integrated with its original commit and GitHub merge credit: production Ruby native-gem builds, matching Bundler settings and runtime libraries, Debian/Alpine support, and an unprivileged runtime reuse the current planner. Historical PHP/Vite and app-service reconciliation fixes were checked in main; PHP vendor-assets repair #467 is in this branch. SQLite persistence requires an explicit persisted database path. Multi-process roles and release phases (#592) remain outside this bug batch, so #231 stays open.

Producer preflight refusals now remain non-destructive in restore reporting. The orchestrator records possible writes only when it hands the artifact stream to the producer, with a cancellation check before that boundary. AOF/credential refusal no longer claims partial data loss; earlier partial writes still retain their warning.

The final PR audit preserves Redis/Valkey snapshot settings when artifact opening or CONFIG SET acknowledgement fails before any write. Restore downloads now propagate source errors and close on early target refusal; possible partial writes still require recovery before restarting.

Commits: [`f1dc8a74`](https://github.com/oblien/openship/commit/f1dc8a740210c542215de0e287740abef259db5f), [`38cc1a03`](https://github.com/oblien/openship/commit/38cc1a0395ac3f2c4b34b005cf0d5d450d66d6a6), [`9ede7762`](https://github.com/oblien/openship/commit/9ede77620bc7eb500ee1568aa7f3d46d61932703), [`3822b062`](https://github.com/oblien/openship/commit/3822b0620f5cb4f1c57e462b5a441023d1df6846), [`e4587335`](https://github.com/oblien/openship/commit/e4587335306102f65db4db55a339b45500c32b9c), [`8c4626e8`](https://github.com/oblien/openship/commit/8c4626e8ef367de329c95c9c4501d1761284b45f).

Verification: PR #468: 1,059 core cases and 224 API stack/language cases pass; nine new cases fail against main.

Verification: Valkey: 57 adapter and 52 core cases pass; eight selected regressions fail against main. A real Valkey 8.1.10 container captures and restores authenticated data after restart, and refuses invalid credentials, denied CONFIG SET and AOF without writes. Adapter TypeScript passes.

Verification: PR #469: 63 recipe/entrypoint tests and adapter TypeScript pass. Real Debian and Alpine images compile/load a native gem, run without build tools as UID 1000, and retain storage across replacement containers; main-generated images fail the native-gem build.

Verification: All 255 backup/restore tests pass. Two unsafe-RDB preflight reporting regressions fail on main and pass here; the full API suite also passes.

Verification: The host-command ownership guard now recognizes the generated Ruby Dockerfile as image installation, separately from host provisioning. Its allowance is restricted to the Debian/Alpine install verbs; the full adapter suite passes 3,788 tests.

Verification: Failed open/acknowledgement/transport regressions fail before the persistence repair. Broken downloads previously timed out with an unhandled error; source failure and early input refusal now finish cleanly. All 33 Redis and 116 focused API terminal/restore cases pass.

### #220: fixed-in-branch

Current main blocks style elements but still leaks through escaped CSS URL names/schemes, image-set strings and CSS-variable substitution; reproduced four bypasses in Chromium.

Adapted and merged contributor PR #222 with its history and GitHub merge credit. One parsed-HTML/CSS policy handles images and CSS; only inline resources are exempt. Existing XSS protections are retained. Relative URLs are blocked, data srcset commas are preserved, and inactive CSS text is not rewritten.

Unresolved CSS variables/attribute substitutions and unparseable declarations fail closed while remote images are blocked. Enabling images uses original sanitized styles.

Commits: [`8138b1ee`](https://github.com/oblien/openship/commit/8138b1ee521579d77fef05a3b81ff690db369bca).

Verification: 77 mail-server regression cases and TypeScript pass; 11 cases fail against main.

Verification: 12 Chromium checks: six payloads in blocked and enabled modes. All blocked requests were suppressed; enabled positive controls fetched. Requests were intercepted and aborted, not delivered to external trackers.

### #216: partial-branch

PR #219 is adapted to the email server’s existing Bun runner and merged into the integration branch with Ahmed Hesham Abdelkader’s original commits and GitHub merge credit. It adds crypto, IP, rate-limit, schema and sanitizer coverage while retaining current privacy tests. This ongoing test-coverage umbrella remains open.

Contributor PRs #243 and #248 are integrated with cherchali mohamed walid’s original commits and GitHub merge credit. Current dashboard parsers, stream callbacks and Button behavior gain coverage using the existing Vitest/Happy DOM setup. Existing phase/status suites are retained; unused legacy phase helpers and malformed-payload quirks are not treated as production fixes. PR #247 is already merged and #224 already closed; #193 is already merged.

Final integration validation caught argument forwarding in the compound root test script: matrix filters were reaching its trailing script-test command, causing both filtered CI jobs to rerun the full workspace suite. CI now invokes Turbo directly for those groups and runs script tests once in Other packages. Native SDK/CLI bundle builds remain sequential; the required aggregate Test check is unchanged.

The root test command also retains its original single-runner shape so developer --filter arguments stay compatible. Script tests have an explicit test:scripts command and execute once in CI; CONTRIBUTING.md documents both entry points.

Commits: [`b6a41165`](https://github.com/oblien/openship/commit/b6a41165d65f94325510179335cbff7456774ceb), [`508adde8`](https://github.com/oblien/openship/commit/508adde85b4bac18c6124e510f2569f145bc2a7e), [`0558e611`](https://github.com/oblien/openship/commit/0558e611cfbd2ccd02cbec6bafb2203a0af7c943), [`435f408c`](https://github.com/oblien/openship/commit/435f408c7e3c5b156b7479c4986a1c8138cce182), [`d2b4d2f9`](https://github.com/oblien/openship/commit/d2b4d2f9f9f01c483adebac5d27c234050c41cc4).

Verification: PR #219: all 110 mail-server tests pass (33 added); server TypeScript and an isolated typecheck of the adapted tests pass.

Verification: PR #243 adds 23 environment/subdomain cases; 68 tests pass with the existing status/log-entry suites. PR #248 adds 78 stream and ten Button cases; 91 pass with the existing install-phase suite, and dashboard TypeScript passes. The full dashboard suite passes 1,462 cases.

Verification: An isolated Bun 1.3.10 probe reproduced the forwarding error. Actual Turbo dry runs select only SDK/CLI in one job and the remaining packages in the other; their union plus the API, database and dedicated mail jobs covers every test workspace without overlap. Workflow YAML parses. All 36 desktop tests also pass.

Verification: An actual root-command dry run with SDK and CLI filters selects exactly those two workspaces.

### #195: fixed-in-branch

Confirmed on main: the environment flag selects an env_var set and does not change the project id, so preview builds could replace production runtime state.

One platform policy now rejects non-production variable sets on a production target before deploy/refresh/build-access mutations, on redeploy, and before legacy queued workers start. Successful previews still activate their own project row.

The shared native/remote source workflow passes its deployment variable set to ensureProject, which validates before updating configuration/services or creating a production target. Existing per-project default variable sets remain compatible. Documented the explicit preview-project workflow.

Commits: [`e965f5cb`](https://github.com/oblien/openship/commit/e965f5cb71865fc2b27c3da5ca9a95ca780cf51d), [`ece434ec`](https://github.com/oblien/openship/commit/ece434ecf72ef7c7e9d271c6a41e5fbe7598c1cb).

Verification: 262 API/engine/parity cases, 17 SDK source cases, and API TypeScript pass. All 11 focused environment regressions pass after the final policy review.

Verification: Seven API regressions plus the SDK ensure-payload regression fail against main.

Verification: Final public-package audit caught and fixed a TypeBox declaration-generation failure from spreading the shared environment schema. The builder-based schema preserves the same contract; full public SDK/CLI build and isolated installed-package lifecycle verification now pass.

### #192: fixed-in-branch

Main still used notes-from-tag for lightweight release tags. Contributor PR #591 is merged with author history and GitHub merge credit, adapted to the existing core changelog owner.

Website, updater and release workflow share exact version parsing. Workflow passes notes as a file, has a missing-entry fallback and bounded output, preserves edited notes and never treats a failed read as empty. Parser-only imports work without installing dependencies.

Commits: [`d4d62906`](https://github.com/oblien/openship/commit/d4d6290614441a1a48d8dc485cc8b7cd66791f77).

Verification: 30 script cases and 27 core changelog/updater cases pass; core and website TypeScript pass.

Verification: One exact-version regression fails against main; two argument/truncation regressions fail against the original PR.

Verification: Bare checkout extraction succeeds. Extracted workflow shell passes fresh-release, empty-description, manual-description, failed-read and failed-edit cases with stubbed GitHub commands.

### #148: partial-branch

Revalidated the historical SECURITY.md findings against main. SEC-01 already enforces scoped-token, read-only and expiry ceilings. SEC-02 and SEC-03 remain real and are fixed in this branch: local host/socket access requires the host-owning organization in self-hosted mode, and active deployment references must match both project and organization before runtime, container, log, terminal, monitoring, routing or cleanup use. Project import preview/apply and restore validation reject invalid bindings. One core ownership predicate and shared engine loaders enforce the same rule across callers.

The security-help umbrella remains open. The September 5 report is retained with current remediation status; the bounded checks are not an exhaustive security certification. Contributor security PRs #152 and #193 are already merged; #224 is already closed.

Terminal resume now binds the parked session to the target authorized by the fresh handshake, in addition to the existing user, project and organization checks.

Commits: [`3c35e5ba`](https://github.com/oblien/openship/commit/3c35e5bad490c6e631eef167d03c8f936e758aff), [`dacf2b0e`](https://github.com/oblien/openship/commit/dacf2b0efef713076d0404f42cd55d379ae945b6).

Verification: 18 API boundary regressions and three database import regressions fail against main and pass on the integration branch. The full API suite passes 6,221 tests across 523 files; the full database suite passes 327 tests across 40 files. API TypeScript passes. Valid owner/native/desktop paths, historical deployment logs, and rollback/Compose lifecycle cases remain covered.

Verification: Both terminal target-substitution regressions fail before this hardening; valid same-target resumes remain covered.

### #123: fixed-in-branch

Main already applies per-user/per-route limits after authentication and one central policy to raw Better Auth routes. The missing follow-up was a coarse limit before session lookup.

Adapted and merged contributor PR #232 with original history and GitHub merge credit. A distinct flood-ip bucket runs before authentication; cloud/explicit edge trust bypasses only that ceiling, retaining per-route and login policies. Configuration uses the current platform schema.

Commits: [`328d5ceb`](https://github.com/oblien/openship/commit/328d5cebe2802bb61a513c3e501637f18031aa9e).

Verification: 55 rate-limit and auth/invitation cases and API TypeScript pass.

Verification: Three behavioral regressions fail with the flood guard disabled; IP buckets stay independent and a rejected flood never reaches authentication.


## Related contributor PR repairs

### PR #196: Retry failed SSL renewals and preserve CLI login endpoints

Status: merged-into-integration. Commit: [`2f37a0a3`](https://github.com/oblien/openship/commit/2f37a0a394bd2bbe445d398b89f391ec0278d69d).

Reviewed all five original fixes: deploy response IDs, server-removal guards and failed-install exit codes already exist in main. The certificate retry and login endpoint defects remain valid.

Adapted the contributor PR to current platform/SDK ownership and merged with original history plus GitHub merge credit. Due errored certificates retry; organization renewals share the configured window, skip externally managed TLS and require a verified renewal outcome. Login preserves independently configured endpoints and saves only after token validation.

Verification: 47 API/TLS/server-removal cases, 17 CLI cases and a real PGlite selector case pass; API and CLI TypeScript pass.

Verification: Six regressions fail on current main.


## Integration validation

- API: 6,221 tests across 523 files; database: 327 tests across 40 files. Full suites pass, including Compose, import/restore, terminal and workload ownership regressions.
- Core: 1,068; adapters: 3,788; contracts: 14; SDK: 153; platform: 115; CLI: 549; dashboard: 1,462; desktop: 36; email server: 110; script tests: 30. All pass. Workspace runs use bounded worker counts.
- Repository-wide lint/typechecks and their build dependencies pass (22 tasks); the email server and adapted mail tests also type-check.
- The built public openship package installs and runs on Node 22.21.1: ESM/CommonJS, NodeNext declarations, passive imports, native deployment/redeployment, tenant isolation, revocation, persistence, remote submission, and CLI lifecycle/cleanup pass.
- Documentation verification passes: 160 pages, 367 SDK methods, 559 HTTP routes, 205 CLI command paths, 226 CLI examples and 107 public-SDK examples. CLI references were regenerated from the built package.
- Issue-specific negative tests fail on the unchanged main baseline and pass with their fixes; the findings above link the relevant commits. Real Docker, SSH, browser, mail and runtime probes are recorded beside the affected issues.
- Production API/dashboard build passes (10 tasks), including the Next.js production compilation and TypeScript check.
- CI matrix selection is verified with actual Turbo dry runs; the compound-script argument forwarding regression is corrected, and every workspace test plus script tests remains included.
- Closure recheck: 108 reports are classified, including the new feature follow-up #894. All 39 resolved reports are closed with evidence (23 fixed here, 16 already fixed in main). The 69 remaining reports have explicit partial, reproduction-dependent or feature status.
- Closure recheck at 0285ccb2: 354 targeted GitHub, monorepo, log/terminal, Compose, service-state, app-routing and mail regression cases pass across 20 files. Application code is unchanged by the tracking update.
- Final PR audit: all 112 pre-review commits and 257 changed files traced against main, including manual merge resolutions and superseded architecture paths. Five additional defects repaired in three code commits; 253 focused tests and 12 typecheck/dependency-build tasks pass. See the [PR review](pr-892-review.md) for the commit index and issue-by-issue result.

Feature requests remain outside this bug batch. Reproduction gaps stay open with a diagnostic request. Issues fixed on this branch are closed with a comment identifying #892 and the pending merge to main; partial and ongoing umbrella reports stay open.
