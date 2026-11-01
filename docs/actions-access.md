# Actions access and approvals

The shared workflow editor uses **Workflow → Run settings → Access → Checks**.
Run settings chooses when a workflow triggers and where it runs. Access chooses who
may use those destinations and whether execution needs approval. A trigger does not
grant execution permission.

## Policy and defaults

Newly saved workflows default to **Only my account**, **Approve each run**, and
**Block fork runs**. Repository policies identify the connected GitHub account by
its verified numeric ID. Selected-user policies resolve usernames to IDs before
saving, so renaming an account does not transfer permission. Repository collaborators
must have write, maintain or admin permission. Both the original actor and the actor
requesting a retry must be eligible.

Standalone workflows use the authenticated Openship account or authorized workspace
members. Existing organization, repository and destination permissions still apply.
Only an Actions administrator who can administer the selected destinations may
approve. The server checks permissions again when approval is submitted.

**Automatically allow eligible users** skips the Openship review for trusted runs.
It does not bypass the audience restriction or GitHub's own protections. Eligible
fork requests always require review and can use only disposable Cloud runners.
Connected servers, including Macs, never receive fork execution. GitHub
`pull_request_target` runs are also treated as untrusted.

Each approval applies to the displayed run, commit and attempt. Its review key also
binds the actors, repository, access policy, allowed destinations and runner execution
configuration. A changed review cannot reuse an earlier approval. Renaming a runner
or updating its health probe does not change execution permission. A GitHub Checks
re-run uses the signed webhook sender, not the workflow owner's delegated identity.

Open the run's **Approvals** tab to review its commit, attempt, requester and
destinations. A yellow icon marks a pending or blocked review. Switching tabs preserves
the selected job, step and log cursor. The review refreshes after submission; cancelled
or finished attempts cannot still be approved.

## GitHub controls

Repository files in `.github/workflows` still use GitHub's controller and the official
runner on the selected Openship destination. GitHub owns event matching, protected
environments, fork approvals, workflow attempts and Checks. Openship's Access step
adds destination authorization and links to repository settings; it does not configure
GitHub reviewers or approve GitHub's pending reviews on the user's behalf.

GitHub's default fork protections do not require approval for every collaborator push.
Choose **Approve each run** for that behavior, or explicitly enable automatic execution
and manage the applicable protections in GitHub. A run can need both approvals.

## Execution boundary

The controller checks admission before reserving or provisioning a runner. A repository
runner can nevertheless receive a different matching GitHub job than the job that
caused it to be provisioned. Checking only that original demand would allow a bypass.

The worker therefore holds the official Listener's actual assignment before launching
the original `Runner.Worker`. It publishes only repository/run/attempt identifiers and
a random nonce through the existing authenticated worker-inspection transport. The
controller reads the actual GitHub run and assigned runner, verifies the current policy
and approval, and durably binds its decision to that session and job. Only an allowed
decision starts Worker; the original IPC payload is relayed unchanged. Workflow code,
action downloads and `always()` steps cannot run before that decision.

The adapter uses GitHub's **private local ProcessChannel IPC format**, rather than a
public admission API. Malformed or unsupported framing, missing identity, denial,
cancellation and the 120-second deadline fail closed. An upstream runner protocol
change can therefore stop execution until the adapter is updated. Keep the real IPC
tests and official-runner verification when upgrading. This gate is not a sandbox for
an approved workflow: connected native runners execute as the configured server user,
and Docker-socket access grants control over that server's Docker daemon.

Neither the full assignment nor job credentials are written to the admission journal
or diagnostics. Decisions are immutable and retries are restricted to the same nonce
and job while authorization remains valid. Revocation prevents new execution; an
already executing trusted workflow still needs supervision and normal cleanup.
Temporary VMs and runner registrations retain their capacity reservation until cleanup
is confirmed.

## Upgrade and validation

Migration `0186_actions_access_policy` adds nullable policy/admission data without
rewriting workflows or credentials. Existing independent workflows retain their prior
execution behavior until saved with an explicit policy. Existing GitHub workflows
without a policy require access review before new runner execution.

Tests cover HTTP and native SDK permissions, identity and approval changes, concurrent
mirroring, actual assignment to a different workflow, missing runner metadata, retry
webhook identities, cancellation, migration and UI recovery. Worker tests use real IPC
frames and verify that denial cannot start Worker. Live verification uses an isolated
private test repository, connected macOS execution and disposable Cloud Linux VMs;
it checks approved execution, revoked access before Worker and resource cleanup.

## Independent reusable sources and OIDC

Called workflow sources are authorized and pinned before admission. The approval
key includes every saved source SHA and content digest. Called jobs share the
root run's identity and policy, but reserve capacity on their own allowed
destinations. Secrets are evaluated in memory at each call boundary, and token
permissions cannot expand beyond the caller. Cancelling or failing a call drains
its workers before releasing its coordinator capacity.

OIDC uses an instance-wide RSA key encrypted with the instance's credential key.
Only public verification parameters are returned by discovery/JWKS. Purpose-bound
request capabilities identify one organization, run and job; the token endpoint
rechecks current authority, admission, assigned runner, execution start and
cancellation before signing. Fork runs cannot request identities. Tokens expire
within five minutes, and edited workflow subjects are marked as overrides.
External services must trust the Openship issuer explicitly.
