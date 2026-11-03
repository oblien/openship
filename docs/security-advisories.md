# Security advisories and server maintenance

Openship checks public advisory metadata against recorded image digests, observed
runtime versions and specifically targeted Ubuntu host packages. Security notifications
are enabled by default. **Automatic deployment changes are off by default.** Host
package installs and kernel reboots always require explicit review.

Workspace owners and admins can turn off **Check security advisories** in
**Settings → Notifications**. This saved workspace policy pauses runtime and host inspections,
new advisory alerts, host patch actions and automatic security refreshes, including refreshes
that have not passed their worker's final check. Work already executing can finish.
Monitoring shows that checks are disabled; it does not report a clean scan. Existing
observations and project refresh consent are retained and used again when checks
resume. Public feed polling, platform updates and other workspaces remain independent.

## What users see

Matching runtime advisories appear in the existing root-level critical/update
banner, on Home and every dashboard page. **Review affected apps** opens one
dialog with the affected applications, services and detected evidence. You do not
need to open a project or deployment to discover a warning. The review links to
the upstream report and offers **Refresh images & redeploy** when applicable. It uses
the existing deployment pipeline, billing admission, service scope and health
checks. A mutable tag can be pulled again even when its name has not changed.
Configured versions and digest pins remain unchanged. A pinned vulnerable image
requires an explicit configuration change; rebuilding a pinned vulnerable
Dockerfile does not fix it automatically.

If the advisory has no patched release in the observed runtime's major version, the
review explains the required major upgrade and opens the existing saved deployment
configuration. For example, refreshing a Node 20 image cannot supply a patched Node
22 runtime. Review the version/image or Dockerfile change and redeploy explicitly;
the advisory action never silently upgrades application runtime majors.

The review distinguishes confirmed matches, possible tag matches, unavailable
checks and incomplete runtime coverage. No matches is not an assurance that an
application has no vulnerabilities. Runtime probes report installed versions;
they are not cryptographic attestation and cannot establish whether a particular
application exposes a vulnerable code path.

**Monitoring → Security** keeps the same app/service review and per-app automatic-refresh
controls accessible after the banner is dismissed. Dismissal only hides the banner;
active findings remain in Monitoring until new evidence no longer matches the advisory.
The banner's settings menu can also hide runtime security banners in the current
browser and account/workspace, including critical notices. Restore them with
**Settings → Notifications → Show security banners**. This does not disable inspection,
notification delivery or any project's automatic-refresh policy. Cloud operational
notices remain independent.
After the dashboard observes a successful deployment of an affected app, it rereads that
app's deployment-keyed security inventory and refreshes the shared overview. Starting a
redeploy, a failed deploy, or a successful build that still contains the affected runtime
does not resolve a finding. Unavailable or incomplete checks remain marked as such.
The Open tab links to these findings. Settings → Notifications also opens the shared review.
The public advisory feed is global. Findings belong to projects or customer-operated
servers in the current organization and are filtered by the viewer's resource access.
They are not private to the person who first saw them. Banner dismissal is a
browser/app preference, scoped to that account and organization for runtime advisories.
Each enabled, verified notification channel inherits these alerts, including channels added later.
Users can turn individual channels off; administrators can change workspace
defaults. Membership, resource access, channel ownership and current opt-outs are
checked again before delivery. Unverified or disabled channels do not receive
alerts. Repeated scans and restarts reuse durable delivery keys. Advisory revisions
can issue a new notice; routine feed-signature renewals do not.

Alerts contain the project, detected evidence, issue explanation and next step.
Critical, announced Openship release notices also use these channels, including
workspaces without deployed projects. Automatic refresh outcomes report a verified
replacement separately from a failed or unverified deployment.

Cloud customers do not receive control-plane self-update prompts; Openship
operates that infrastructure, and Cloud operational notices retain their existing
delivery flow. Customer application images and runtimes still receive scoped
advisories on Cloud, including connected servers. Managed infrastructure does not
change a pinned application runtime. Those projects also remain notice-only until
a project writer explicitly enables the limited automatic refresh policy below.

A full instance move retains the same identities, security consent and refresh
attempts. Individual project imports reset observations and consent, with a preview
warning; they never carry another owner's automatic-update authority or replay
source refresh attempts. Public feed caches and polling leases are fetched again.

## Polling and inventory

The built-in `security:advisories` job runs every five minutes while Openship is
running. Desktop must be open; this does not install a separate agent on servers.
The backend shares a persistent cache and leases across browsers and workers:

- With a usable GitHub credential: at most one check per feed every five minutes.
- Without one, or after GitHub rejects it: one check per feed every hour.
- Conditional requests use ETags. Rate limits and transient failures back off;
  refreshing the browser or connecting a credential does not override an already
  scheduled delay. Subsequent requests use the credential's polling interval.
- Release metadata and independently published security metadata are separate
  cached documents. Tagged changelog and release notices remain independent.
- Credentials go only to the fixed GitHub API endpoints, never raw content URLs.
  Nothing uploads customer names, inventory, environment variables or logs.

See [GitHub's REST API guidance](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).
Shared-IP rate limits can still delay checks; a five-minute schedule is not a
delivery-time guarantee.

The inventory reads existing deployment receipts. Version commands come from the shared stack/runtime registry compiled
into Openship, run only through an adapter's isolated container executor, have a
ten-second timeout, and run with concurrency two. Supported version probes cover
Node.js, Bun, Deno, Python, PHP, Ruby, Java, .NET and Go. Missing shells, stopped
containers, unsupported formats and Bare processes remain unknown; there is no
fallback to executing commands on a shared host. Only runtime families named in
current advisory rules are probed. With no runtime advisories, there are no
container exec calls. Observations occupy one current cache per project, keyed
by the active deployment and advisory rules. Healthy observations expire after six
hours with deterministic jitter. Unavailable checks retry after five minutes, backing
off to one hour with jitter. Changed rules or deployments, **Check again**, and
pre-patch verification request fresh observations. A per-project lock coalesces
concurrent work across workers. Failed probes preserve previous matching warnings
for the same rules and deployment, mark coverage unknown and block refresh actions.
Expiry does not silently clear a warning. Unknown observations are never reported safe.
Each inspection and background sweep has a work budget, so large installations can require multiple sweeps. New deployments invalidate inventory.

### How a new announcement becomes a finding

1. The shared poller verifies the signed feed, its revision and expiry, then
   stores the verified document. A new feed revision makes projects eligible for
   evaluation on the next bounded sweep. The root feed response aggregates current
   observations using the same matcher; it never executes a container command.
   Only authorized projects in the current workspace contribute findings or
   counts. Changed rules or active deployments are marked pending until inspected.
2. The evaluator reads the active deployment's existing image receipts
   (`deployment.meta.runtimeImages` and service deployment image digests).
   Runtime versions are inspected on demand and cached in
   `project_security.inventory`, together with the deployment ID, rule fingerprint
   and check time. This is one replaceable observation, not a report stored with
   every deployment or a permanent “patched” flag.
3. Each evaluation compares the current advisory rules with that evidence in
   memory. New or changed runtime rules invalidate that observation; unchanged rules
   reuse it. Renewing a feed signature, polling it, or reopening the page does not
   rerun version commands. Image-only advisories reuse deployment receipts without
   executing a container command. Exact image
   digests and observed runtime version ranges can confirm a match; a tag alone
   only produces a possible match. An image tag is never treated as a runtime
   version.
4. Matching findings appear in the global banner and go through the existing
   notification queue. Durable keys prevent repeated scans or feed-signature renewals from sending the same notice
   again. Updating the advisory's own revision can produce a new notice.

Inspection checks the deployment ID again before saving new evidence. Applying a
notice requires its reviewed deployment ID under the existing project lock;
automatic work also rechecks consent, configuration and the signed instruction
before execution. A deployment change invalidates the inventory and causes a new
inspection. A successful build alone never marks a runtime fixed.

For example, `node:22-alpine` can still have the same tag after a patch. Openship
compares the recorded digest and observed `node --version`, then inspects the new
deployment again after refresh. It does not infer protection from “latest” or from
an unchanged tag. This is curated advisory matching, not an image filesystem,
or application dependency vulnerability scanner. Host rules below inspect only
the specific packages named in the signed feed, rather than every installed package.

## Customer-operated server maintenance

Monitoring → Security shows the workspace's advisory inspection task, last completion,
schedule, pending/partial/interrupted state, and the link to its default-on policy.
Cloud gets workspace-local task status, without exposing other tenants' system jobs.
The background sweep has separate bounded project and host budgets. Host cache reads
are batched; no host advisory rules means no host enumeration or execution from the
root banner. Host observations share the six-hour expiry and bounded failure backoff.
Changed server connections invalidate review and make the host eligible for inspection.
Unsupported/offline hosts back off instead of monopolizing every sweep.

A host finding opens **Servers → Runs**. **Check again** only inspects. **Review patch**
refreshes APT metadata and shows every exact package/version change, including dependencies.
**Apply reviewed patch** creates a persistent server run with bounded output and a verified,
reboot-required or needs-review outcome. It never redirects to a project deployment.
Runs uses the existing Jobs recorder and event bus, deployment pipeline logger and
log sanitizer, and the shared terminal. There is one persisted run per approval:
preflight → reviewed install → independent package verification and component checks.
Setup's Docker/Edge checks run before and after maintenance; only previously healthy
components are required to stay healthy. Missing patch prerequisites stop the operation.
Preparation and execution take the same provisioning lock as deployments and component
setup. APT download/install progress follows the shared bounded log pipe, with durable
checkpoints and sequence-aware replay. Opening the run stream never replays Apply.
The final observation is saved before success is published, so the finding and run agree.

Host patching is always explicit; workspace alerts do not authorize installs or reboots.
The initial implementation supports Ubuntu hosts with `/usr/bin/python3` and `python3-apt`.
Installation needs root or noninteractive sudo; Openship does not install prerequisites
or alter SSH privileges automatically. Container connections are refused.

The signed feed contains data only. Host execution uses a compiled Python APT operation:

- Exact Ubuntu release, package name and Debian fixed version; no shell strings or URLs.
- Trusted Ubuntu base, `-updates` and `-security` candidates only. No enabling `-proposed`,
  PPAs or new sources. Unavailable stable fixes require manual guidance.
- At most 100 package changes; reject held packages, downgrades, removals and broken APT state.
- A ten-minute authenticated approval bound to the actor, organization, server connection,
  advisory content, operation and exact plan. Expired or changed plans require review.
- Recheck permissions, workspace policy and the signed advisory before worker execution;
  hold the server lock and APT frontend lock, then recompute and compare the exact plan.
- Persist run identity before execution; retries of the same token reuse its run. Interrupted
  or unverifiable runs require review and never automatically repeat host side effects.

Provider-managed servers, the Cloud control plane and migration-only connections are
excluded. Customer-owned SSH hosts on Cloud retain the existing management entitlement
and server-admin checks. Local host control and Desktop execution policy still apply.

Kernel rules must include `runningKernel: { sourcePackage, fixedVersion }` with the
Ubuntu source package/version for the actual kernel flavour. Installed packages alone
cannot clear that notice: the running image's source version must also match the fix.
After installation, **Review reboot** shows the workload interruption and creates a
separate approval. Scheduling it reboots the host in one minute. The run remains pending
until a new boot reports a fixed running kernel; offline, old-kernel or interrupted
verification requires review. An acknowledged reboot survives an engine restart as
verification-only work. The existing advisory scheduler closes interrupted or overdue
runs even with checks paused or an unavailable feed; it never retries their commands.
No automatic reboot is implied by installing a patch.
Other package checks verify installed versions; running processes may still need an
operator restart. Version evidence is not application-health or exploit verification.

Example target shape (illustrative package versions, not a published vulnerability):

```json
{
  "action": "patch-host",
  "modes": ["selfhosted", "desktop"],
  "targets": [
    {
      "kind": "host-package",
      "distribution": "ubuntu",
      "release": "24.04",
      "package": "openssl",
      "fixedVersion": "3.0.13-0ubuntu3.16"
    }
  ]
}
```

Supply the normal advisory ID, revision, title, message, severity, URL and publication
time as well. The feed supports at most 200 host targets. `patch-host` accepts only
host targets; `refresh-images` cannot contain them. A host `manual` notice supplies
guidance without enabling patch/reboot actions. Migration `0222_host_security_advisories.sql`
adds expiring observations and workspace task state; it preserves project consent.
Host caches and task state are re-created after an instance move. Existing job-run
history remains local under the normal history retention policy.

## Optional automatic refresh

A project writer can enable **Automatically refresh verified security patches**.
This permits only the following case:

1. A current, correctly signed advisory identifies the deployed image digest as
   affected and names a replacement digest as fixed.
2. An image-only service uses a mutable tag. The registry currently resolves that
   same tag to the signed replacement digest.
3. The deployed service configuration has no pending edits, and a supported
   container inspection confirms the saved and running environments agree.
4. The approving account still has project write permission, consent is still
   enabled, and the active deployment has not changed.

Both manual and automatic actions call the existing runtime-refresh operation.
Automatic work adds a one-run approval containing the original deployment,
approver, expiry, verified image digest and a keyed environment fingerprint.
It does not copy service environment values into another snapshot or use the
rollback/replay path. The ordinary deployment resolver reads the existing
project/service variables, handles interpolation, pulls the approved image and
performs cutover. A comparison against the fingerprint rejects changed values
before the service is replaced. Saved configuration edits remain pending; an
automatic update does not write its snapshot back over them.

The registry image is acquired through the same force-pull preparation used by
manual refresh, with a digest pin for this run. The saved tag remains unchanged.
Consent, active deployment, permissions and configuration are checked again in
the worker. A failed attempt requires manual review rather than repeated deploys.
Revoking consent prevents queued work that has not passed its worker check;
use deployment cancellation for work already executing. Rollback uses its
existing environment and retained-artifact behavior, with no advisory-specific
replay layer.
Normal health checks reduce deployment risk but cannot prove application-level
compatibility or undo database migrations run by an image.

Source builds, major-version changes, digest-pinned services, unknown baselines
and runtime-version-only notices require a reviewed update. The initial Node.js,
Bun Brotli and PHP October 21 notices are runtime-version notices: they do **not** authorize
automatic changes without verified image-digest metadata. After a refresh, the
new active deployment is inspected again; a successful build alone does not
clear a runtime warning.

## Publishing an advisory

Edit the public [security-advisories.json](../security-advisories.json). The strict
schema is in [security.ts](../packages/core/src/updates/security.ts). Every advisory
has a stable ID, its own revision, severity, publication time, HTTPS reference,
explanation, declarative targets and `manual`, `refresh-images` or `patch-host` as
its action. Optional `modes: ["selfhosted"]` limits a notice to that controller mode;
`desktop` and `cloud` are also supported. Omission means all modes. These are
controller modes, not permission to access provider-managed infrastructure. Increment the advisory revision when its substance changes. Image
repositories match exactly after Docker Hub alias normalization. Runtime targets
use semver ranges with explicit fixed ranges. A manual notice can use `fixed: null`
when upstream has no published fixed range; it cannot authorize an image refresh.
Do not infer a fix from a tag alone.

The PHP October 23 session-upload-progress follow-up is a separate manual notice.
It remains visible on the October 21 patched PHP releases, because a version probe
cannot verify web-worker configuration or the application's session behavior.
Operators must review `session.upload_progress.enabled=0` in server configuration
and restart every worker as directed by [PHP's advisory](https://www.php.net/archive/2026.php).

The [publishing workflow](../.github/workflows/security-advisories.yml) runs after
relevant main-branch changes, daily, or on manual dispatch. It validates the
source and signs the exact manifest with `OPENSHIP_DESKTOP_SIGNING_KEY`, matching
the existing public update trust root. The signature has a separate advisory
domain prefix, a monotonic feed revision and a fourteen-day expiry. The workflow
publishes `security-advisories.v2.signed.json` on the public `security-advisories`
branch. It also publishes the legacy filename with only unscoped project/platform
notices: old strict-schema clients cannot parse host targets or mode restrictions.
The legacy view excludes scoped notices rather than broadening their audience.
Both files are committed atomically. Client caches
reject invalid signatures, stale revisions, altered equal revisions, oversized
responses and expired update instructions. Last verified, expired notices remain
readable but cannot authorize an update.

The feed contains no shell commands, executable downloads or arbitrary API
actions. Trust-root changes require shipping new Openship code. Publication needs
the repository signing secret and write permission; neither a local source edit
nor an unsigned JSON upload enables the feed. Until the first successful signed
publication, clients report advisory checks unavailable.

## API and SDK

HTTP, native SDK and desktop use the same operations and permissions:

| SDK operation                                                               | HTTP endpoint                             | Permission    |
| --------------------------------------------------------------------------- | ----------------------------------------- | ------------- |
| `updates.advisories()`                                                      | `GET /updates/advisories`                 | Updates read  |
| `updates.checkSecurity(projectId)`                                          | `POST /updates/:projectId/security/check` | Project read  |
| `updates.security(projectId)`                                               | `GET /updates/:projectId/security`        | Project read  |
| `updates.securityPolicy(projectId, { autoRefresh })`                        | `PUT /updates/:projectId/security/policy` | Project write |
| `updates.applySecurity(projectId, { advisoryId, deploymentId, serviceId })` | `POST /updates/:projectId/security/apply` | Project write |
| `servers.security(id)`                                                      | `GET /system/servers/:id/security`        | Server read   |
| `servers.checkSecurity(id)`                                                 | `POST /system/servers/:id/security/check` | Server admin  |
| `servers.planSecurityPatch(id, { advisoryId, operation })`                  | `POST /system/servers/:id/security/plan`  | Server admin  |
| `servers.applySecurityPatch(id, { token })`                                 | `POST /system/servers/:id/security/apply` | Server admin  |
| `servers.securityRunEvents(id, runId)` | `GET /system/servers/:id/security/runs/:runId/stream` | Server admin |
| `servers.securityRuns(id)`                                                  | `GET /system/servers/:id/security/runs`   | Server admin  |

The CLI exposes `openship server security get|check|plan|apply|runs`. Plan and apply
accept JSON files (or stdin), and `--schema` prints their input. A plan operation is
`install` (default) or `reboot`. Apply accepts only the reviewed token and prompts
before mutation (`--yes` for explicitly authorized automation). The SDK/native and
HTTP operations share the same schemas and authorization.

Project apply requests carry the reviewed deployment ID. A changed active deployment
requires checking the notice again. Remote inputs cannot provide replacement
images, commands or the internal automatic-deployment instruction.

## Validation and rollout

Host coverage includes token tampering/expiry/scope, changed connections/advisories,
revoked permissions, queued policy opt-out, Cloud/provider exclusions, cache expiry,
retained warnings, migration retry, replay admission and kernel reboot verification.
Dashboard tests cover review before apply, duplicate clicks, workspace changes,
failed plans, explicit reboot consent and disabled checks. A disposable Ubuntu 24.04
VM validation on November 3, 2026 exercised the compiled Python operation with real
APT: OpenSSL 3.0.13-0ubuntu3.9 → 3.0.13-0ubuntu3.16 plus its library dependency,
held-package rejection, changed-plan rejection and post-install version inspection.
It did not patch a customer server or publish an advisory. Reboot orchestration is
covered with transport fixtures; this is not a fleet benchmark or penetration test.

The implementation includes signature/tampering/replay tests, persistent feed
cache and credential-backoff tests, native/HTTP authorization parity, isolated
inventory and scope-change tests, consent/configuration checks, exact-artifact
result verification, per-channel delivery defaults and opt-out tests, and UI
scope/interaction tests. These use isolated databases and fake external transports;
they do not send customer notifications or update customer containers.

The detection integration test exercises signed publication, new rules triggering
a fresh runtime observation, the authenticated HTTP API, tenant isolation, durable
in-app delivery, duplicate scans and a same-tag replacement with a patched runtime.
GitHub responses and container execution are fixtures in this test; the separate
Docker E2E journey below exercises real containers.

The [browser capture](screenshots/security-advisories/README.md) uses the actual
dashboard component and theme with explicitly labelled sample data. It checks
notice expansion, default-off consent, scoped requests, changed-deployment errors,
stale-feed blocking, manual checks and mobile layout.

`apps/api/test/e2e/security-advisories.e2e.test.ts` runs affected Node.js 22.23.3
and PHP 8.4.26 containers, real isolated version probes, in-app notifications,
manual same-tag Node refresh, and a consented, digest-pinned PHP refresh through
the shared deployment worker. It verifies preserved environment/data, unchanged
untargeted containers, concurrent admission, the running patched versions, and
the remaining PHP configuration notice. No service publishes a host port.
The old and patched runtime versions are explicit fixtures so future upstream
releases do not change the expected result. The configured image tag remains the
same across each replacement. This journey runs in the PR CI matrix and release gate.
GitHub transport is a fixture and signing trust uses a test-only key; this does not publish a
real advisory. This test is not an exploit or penetration test.

Run it with a dedicated Docker daemon:

```sh
RUN_DOCKER_E2E=1 bun run --cwd apps/api test:e2e test/e2e/security-advisories.e2e.test.ts
```

A missing daemon fails the required run. The test removes its containers,
networks and volumes; production feed publication remains a rollout step.

Validation on October 24, 2026 used a dedicated, temporary Colima Docker daemon.
All three real-container journeys passed, including Node.js 22.23.3 → 22.23.4
and PHP 8.4.26 → 8.4.27. The test caught and fixed a registry-patch acquisition
issue: a new signed digest must be downloaded before cutover, not treated as a
retained local rollback image. Rollback also clears the one-time security
instruction. The fixture's containers, volumes and networks were removed.

Deploy the code with migration `0205_security_advisories.sql`, publish the signed
feed, then verify a notice on a controlled test project before offering automatic
updates. Existing installations retain notice-only behavior until a project
writer explicitly opts in.
