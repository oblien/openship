# Security Policy

We take the security of Openship and the data it manages seriously. We're
grateful to the researchers and users who help keep Openship and its community
safe, and we welcome your reports.

## Reporting a Vulnerability

Please report vulnerabilities **privately** — don't open a public issue, pull
request, or discussion, and don't disclose the issue publicly until we've had a
chance to address it.

Use either channel:

- **GitHub Private Vulnerability Reporting (preferred):**
  <https://github.com/oblien/openship/security/advisories/new>
- **Email:** <security@oblien.com> — if the details are sensitive and you'd like
  to encrypt them, email us first and we'll arrange a secure channel.

You don't need a complete or polished report to reach out. A partial finding is
far more useful to us than a silent one — send what you have and we'll work
through it with you.

## What to Include

The more of this you can provide, the faster we can validate and fix:

- A clear description of the issue and its security impact
- Step-by-step reproduction, with a proof-of-concept where possible
- Affected component(s), and the version, commit, or URL
- Any preconditions (auth level, configuration, self-hosted vs. cloud)
- Suggested remediation, if you have one

## Safe Harbor

We consider security research and vulnerability disclosure carried out in good
faith under this policy to be **authorized**. For such research we will:

- Not pursue or support legal action against you related to your research
- Work with you to understand and resolve the issue promptly
- Credit you for a valid, first-of-its-kind report, if you'd like

Good-faith research means you:

- Only test against scope you're authorized for — your own account, your own
  self-hosted instance, or a test account you control
- Avoid privacy violations, data loss, and service degradation; access only the
  minimum data needed to demonstrate the issue
- Never exfiltrate, store, or share data belonging to others, and delete any
  incidentally accessed data once it's reported
- Give us reasonable time to remediate before any public disclosure

If you're unsure whether something is allowed, email <security@oblien.com> and
ask first. Work done consistent with this policy is treated as authorized — if
something is ambiguous, we'll help clarify it rather than treat it as a
violation.

## Scope

In scope — all Openship components:

- Managed Openship Cloud
- Self-hosted control plane (API, dashboard, CLI)
- Desktop app
- GitHub integration & webhooks
- The build/deploy pipeline and deployment targets
- Backups & recovery
- Domains & TLS, and the edge (OpenResty) layer
- Mail functionality

Openship is open source (Apache 2.0), so the fastest and safest way to test most
issues is against **your own self-hosted instance**.

## Out of Scope

- Vulnerabilities in already-public third-party dependencies (report upstream;
  do tell us if Openship is exploitable through one)
- Theoretical issues with no realistic attack scenario or proof-of-concept
- Self-XSS, or issues requiring physical access to a user's device
- Social engineering of Openship staff, users, or infrastructure providers
- Volumetric denial-of-service / resource-exhaustion testing
- Missing security headers or best-practice suggestions with no demonstrated impact
- Raw automated-scanner output without a validated, exploitable finding

## Supported Versions

| Version | Supported |
|---|---|
| Latest release | ✅ |
| Pre-release / beta | ✅ (lower priority) |
| Older releases | ❌ (please upgrade) |

Self-hosted operators: security fixes ship in the latest release — keep your
instance current.

## Our Response

Targets, in business days, from receipt:

- **Acknowledgement:** within 5 days
- **Triage / initial assessment:** within 10 days
- **Fix:** prioritized by severity — critical issues are expedited
- **Coordinated disclosure:** after a fix is available, by mutual agreement,
  typically within 90 days of the report

We'll keep you updated as we work through it, and tell you when a fix ships.

## Recognition

With your permission, we credit reporters of valid, first-to-report issues in the
relevant advisory or release notes. Openship does not currently run a paid
bug-bounty program.

## Questions

For anything that isn't itself a vulnerability report, see the
[Trust & Security](https://openship.io/trust) page or reach us at
<security@oblien.com>.

---

# Focused Security Audit

- Date: September 5, 2026
- Repository revision: `de877cb96180af31fa524662d89f9945952b23ad`
- Scope: shared API routes, deployment/runtime selection, tenant references imported through the cloud API, and background consumers of those references.

## Follow-up — September 16, 2026

Revalidated against main at `4e66349c27b48df13697c1b6d4a95f7a6cf4a3d6`:

- **SEC-01 is already fixed on main.** Shared token management rejects scoped
  credential delegation and enforces the caller's read-only and expiry limits.
- **SEC-02 is fixed in [PR #892](https://github.com/oblien/openship/pull/892),
  awaiting merge into main.** Local execution and Docker reads require the
  host-owning organization on a self-hosted instance. Desktop and explicitly
  permitted native execution retain their existing policies; the cloud control
  plane cannot select itself as a local target.
- **SEC-03 is fixed in PR #892, awaiting merge into main.** Active deployment
  lookups, batch consumers, service-container references and rollback predecessors
  validate both project and organization ownership. Full remapped restores and
  project-import preview/apply share validation of active deployment bindings.

Isolated regressions exercise authorized and mismatched references through logs,
terminal tickets, monitoring and imports. Eighteen API cases and three dump
validation cases fail against main and pass with the fixes. No tests used
production infrastructure or other users' workloads. This follow-up addresses
these findings; it is not an exhaustive security certification.

The September 5 report below is retained as historical evidence. Its file paths
refer to that revision, before the shared engine moved into `packages/platform`.

## Original review status — September 5

This is a source-code audit, not a penetration-test report. Three high-severity authorization gaps were identified through code-path tracing. No live exploitation, runtime operations against application infrastructure, or automated test execution was performed. Deployment-specific impact still requires validation in an isolated environment. No production code was changed.

Severity reflects the prerequisites stated for each finding; none of these findings establishes unauthenticated access or evidence of an existing compromise.

| ID | Severity | Finding | Affected boundary |
| --- | --- | --- | --- |
| SEC-01 | High | Scoped credentials can request an unscoped replacement | Token scope → underlying user's authority; both hosting modes |
| SEC-02 | High | The implicit local deployment target bypasses host-owning organization checks | Project permissions → control-plane host access; self-hosted mode |
| SEC-03 | High | Imported active-deployment pointers can select another tenant's deployment | Owned project → foreign workload; shared routes and monitoring worker |

## Existing safeguards verified

- Permission-tagged routes receive authentication and permission middleware through `apps/api/src/lib/secure-router.ts:1`. This review does not assume that every API route is permission-tagged.
- SaaS mode excludes the system, mail administration, migration, and host SSH terminal mounts through the branch in `apps/api/src/app.ts:297`. The service terminal is a separate, shared surface.
- Explicit server resolution requires an organization and an organization-scoped server lookup in `apps/api/src/lib/deployment-runtime.ts:250` and `apps/api/src/lib/server-target.ts:14`.
- Host-side build work in the cloud runtime defaults to denied: `packages/adapters/src/runtime/cloud.ts:548`. SaaS initialization does not opt in: `apps/api/src/lib/controller-helpers.ts:252`.
- Local backup destinations are checked at consumption time, not just creation time: `apps/api/src/modules/backup-destinations/hydrate-server.ts:36` and `apps/api/src/modules/backup-destinations/local-gate.ts:39`. Server-backed destinations use an organization-scoped credential lookup: `apps/api/src/modules/backup-destinations/hydrate-server.ts:93`.
- Subgraph import remaps organization identifiers, checks several parent references, and redacts encrypted fields. Those are useful controls, but they do not establish the validity of every runtime-related reference described in SEC-03.

## SEC-01 — Scoped credentials can mint unscoped authority

**Prerequisites:** A valid, non-read-only scoped PAT or bound OAuth credential with a `settings` wildcard grant permitting writes. The underlying user must have broader permissions than that credential.

### Evidence

- Token creation and MCP authorization are guarded by `settings:write`, without a separate interactive-session or credential-delegation requirement: `apps/api/src/modules/tokens/token.routes.ts:21`.
- `settings` is an allowed grantable resource: `packages/core/src/access-grants.ts:143`. Restricted principals can satisfy wildcard resource permissions through explicit grants: `apps/api/src/lib/permission.ts:387`.
- `resolveScopeIntent` accepts explicit full-access intent and returns an unscoped result: `apps/api/src/modules/tokens/token.controller.ts:164`.
- `create` validates grant limits only when the new token is scoped, then persists the requested scope without comparing it with the authenticated principal's `tokenScope`: `apps/api/src/modules/tokens/token.controller.ts:281`.
- Authentication applies the restricted principal only when the stored token is scoped: `apps/api/src/middleware/auth.ts:296`. Permission evaluation likewise imposes the token-grant restriction only when `ctx.tokenScope` exists: `apps/api/src/lib/permission.ts:480`.
- The MCP binding path has the same missing delegation boundary. Full-access intent produces an empty grant list; validating that list performs no access checks, and the resulting unscoped binding is persisted: `apps/api/src/modules/tokens/token.controller.ts:437` and `apps/api/src/modules/tokens/token.controller.ts:469`. The edit confirmation is a caller-supplied confirmation, not an additional authorization check.

### Impact

The initial route permission can be satisfied by a deliberately narrow credential, but the newly issued credential is evaluated using the underlying user's membership permissions. This defeats the original token's resource restrictions. It does **not** create privileges beyond those of the underlying user; the escalation is from the delegated credential to that user's broader authority.

The existing protections against accidentally empty scopes and invalid cross-organization grants do not address this path: explicit full-access intent bypasses the scoped-grant validation branch.

### Remediation

- Make credential creation and OAuth binding widening subject to an explicit delegation policy, rather than ordinary workspace settings access alone.
- Prefer requiring an appropriately authenticated interactive session for unrestricted credential issuance and scope widening.
- If scoped credentials may delegate, require the child authorization to remain within the parent's effective resources, organization, read-only restriction, and expiry. Explicit full-access intent must not override those limits.
- Apply the same rule to PAT creation and every MCP consent/edit path. Preserve legitimate narrowing operations without allowing a new unrestricted credential as an alternative path.

**Regression checks:** An owner-backed token restricted to settings writes must not mint an unrestricted PAT or widen an OAuth binding. A legitimate interactive owner should still be able to issue an unrestricted token. Scoped delegation, if supported, must remain a subset of the caller's effective authorization.

## SEC-02 — Implicit local targets bypass host ownership

**Prerequisites:** A multi-organization self-hosted instance, a user permitted to deploy a project in an organization that does not own the control-plane host, and an available local execution channel or Docker socket. Host process permissions determine the eventual operating-system impact.

### Evidence

- The intended boundary is explicit: only the founding administrator's organization may treat the control-plane box as its local host: `apps/api/src/lib/box-org.ts:14` and `apps/api/src/lib/box-org.ts:55`.
- The shared build-access handler checks project write permission and accepts build configuration: `apps/api/src/modules/deployments/deployment.controller.ts:499`.
- Target overrides are applied to the deployment snapshot: `apps/api/src/modules/deployments/build.service.ts:1820`. `resolveSnapshotTarget` prioritizes the requested target and drops the server identifier for a non-server target: `apps/api/src/modules/deployments/build.service.ts:1013`.
- A self-hosted snapshot without a server binding ordinarily resolves to `local`: `apps/api/src/lib/deployment-runtime.ts:309`.
- The explicit server branch uses organization-scoped resolution, but the local branch obtains the instance's local server row and host executor without authorizing the caller's organization against the host-owning organization: `apps/api/src/lib/deployment-runtime.ts:540` and `apps/api/src/lib/deployment-runtime.ts:584`.
- `findLocalServer` resolves the instance's owning organization, not the deploying project's organization: `apps/api/src/lib/startup/self-server.ts:125`. The acquisition helper accepts only a server identifier and reaches the instance host channel: `apps/api/src/lib/deployment-runtime.ts:719`.
- The read-only runtime resolver has a corresponding local branch that opens the Docker socket without a host-ownership check: `apps/api/src/lib/deployment-runtime.ts:1182`.

### Impact

The permission to deploy an owned project can select a host capability that would not be available through the explicit organization-scoped server path. The local factory can return a bare host runtime or a socket-backed Docker runtime. Where those capabilities are privileged, this exposes the control-plane host and potentially other organizations' workloads.

The important distinction is workload execution versus host authorization: permission to deploy application code should not silently establish ownership of the control-plane host.

**Mode limitation:** This finding concerns the self-hosted local-target path. The reviewed normal SaaS target resolver forces cloud execution; this audit does not establish a SaaS host-code-execution path through this finding.

### Remediation

- Require explicit organization authorization before resolving any local executor or local Docker socket, including implicit/default targets.
- Use one host-authorization decision for explicit local server rows, implicit local targets, and read-only runtime resolution.
- Treat a missing or deleted server binding as an unresolved target, not automatic permission to use the control-plane host.
- Keep this check at the runtime-resolution boundary so background jobs and stored snapshots receive the same protection as HTTP requests. Retain a separate fail-closed SaaS prohibition on local host execution.

**Regression checks:** A non-host-owning organization must be denied both explicit and implicit local targets, with no executor acquisition or socket opening. The founding organization's authorized local deployment should continue to work. Deleting a remote server must not retarget its projects to the API host.

## SEC-03 — Imported active-deployment pointers cross tenant boundaries

**Prerequisites:** Permission to import a subgraph into the caller's own SaaS organization, plus knowledge of another tenant's deployment identifier. No membership in the other tenant is required by the code paths described here. The import route remains authenticated and requires `cloud:admin`.

### Evidence

- The SaaS import endpoint accepts a client-supplied dump and binds its organization to the authenticated context: `apps/api/src/modules/cloud/cloud-saas.routes.ts:81` and `apps/api/src/modules/cloud/cloud-saas.controller.ts:685`.
- Import delegates to merge restore with `remapOrgId`: `apps/api/src/modules/cloud/cloud-ingest.service.ts:123`.
- `project.activeDeploymentId` is a plain text column, with no database foreign-key relationship to the owning project: `packages/db/src/schema/project.ts:440`.
- The import self-containment validator checks `projectId`, `deploymentId`, `serviceId`, and several other references, but not `activeDeploymentId`: `packages/db/src/dump.ts:1225`.
- Restore retains known columns while remapping organization identifiers. It does not clear or validate the active-deployment pointer: `packages/db/src/dump.ts:1429`.
- The shared runtime-log service verifies the requested project's organization, then loads its active deployment by identifier alone. It does not require that deployment to belong to the same project and organization before passing it to the runtime resolver: `apps/api/src/modules/projects/project-runtime.service.ts:29`.
- Enable and disable operations repeat that trust transition: `apps/api/src/modules/projects/project-runtime.service.ts:174` and `apps/api/src/modules/projects/project-runtime.service.ts:251`.
- The monitoring worker loads deployments from project active pointers, groups execution using the selected deployment's organization, and associates the candidate with the original project's identifier: `apps/api/src/modules/monitoring/usage-sampler.ts:205` and `apps/api/src/modules/monitoring/usage-sampler.ts:217`. The resulting samples are stored under that project identifier: `apps/api/src/modules/monitoring/usage-sampler.ts:272`.

### Impact

An imported project can belong to the importing organization while its active pointer selects an existing foreign deployment. Permission checks on the project still pass, but subsequent runtime operations use the foreign deployment's identity and target.

The traced consequences are unauthorized access to foreign workload logs, foreign workload start/stop operations, and resource samples attributed to the importing project. The actual cloud-provider response was not exercised; the demonstrated source-level failure is the handoff of an unrelated tenant's deployment to trusted runtime operations.

Organization remapping does not fix the pointer, and an organization-safe server resolver is insufficient when it receives the foreign deployment's own organization as its authority.

### Remediation

- At import, reject or clear active-deployment references that are not part of the accepted import graph. Also require the referenced deployment to belong to the referencing project; mere presence somewhere in the dump is insufficient.
- Before every active-deployment operation, require both `deployment.projectId === project.id` and `deployment.organizationId === project.organizationId`.
- Put this invariant in a shared repository/resolver operation used by runtime logs, lifecycle operations, service handling, monitoring, and other workers. Workers should skip and report invalid bindings rather than adopting the referenced row's authority.
- Review adjacent imported runtime identifiers, including workspace/container identifiers and deployment metadata, as capabilities requiring independent ownership validation. This is a follow-up review requirement, not a separately verified finding here.

**Regression checks:** Use isolated synthetic organizations to verify that cross-project and cross-organization active pointers are rejected at import and at consumption. Confirm that log/lifecycle handlers never invoke a runtime for a mismatched deployment, and that monitoring never records its samples under another project. Valid self-contained project transfers should remain functional.

## Recommended order

1. Close unrestricted credential delegation from scoped principals in both PAT and MCP authorization handlers.
2. Enforce host ownership at local target resolution, including the read-only socket path.
3. Validate imported active-deployment references and enforce the project/deployment ownership invariant at every consumer.
4. Add the targeted regression checks above before treating the affected boundaries as verified.

## Limitations

- The review is focused, not an exhaustive assessment of authentication, all API modules, dependencies, infrastructure, or deployment configuration.
- No executable exploit, live tenant operation, encoding workaround, or decoder was created. No application data or credentials were read for validation.
- Source inspection found existing tests for token scope intent, organization-bound minting, runtime targeting, and dump self-containment. Those tests were not executed during this review, and their existence is not evidence that the three identified cases are covered.
- This report intentionally separates code-path findings from runtime verification. Successful reproduction and remediation should be confirmed with synthetic data and mocked or isolated execution targets, not production tenants.
