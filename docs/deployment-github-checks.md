# Deployment GitHub Checks

Project reporting defaults to one overall Check and Checks for all enabled services.
`project.github_checks` stores the operator's preferences; null selects the shared defaults.
Both Project Source and the deployment wizard use the same control and contract. Reporting
does not enable auto-deploy or change Actions gates.

## Admission and delivery

`queueDeploymentChecks` inserts the rollup intent in the deployment admission transaction.
It captures the repository, stable project/environment Check name, service targeting and
reporting preferences. Imported history is not reported. Admission does no GitHub I/O.

The existing system job runner executes `github:deployment-checks`. The indexed queue and
renewable row lease support restarts and multiple API replicas, with at most four deliveries
in parallel per sweep. Each attempt reads the stored deployment and service lifecycle,
including failures before the build pipeline starts. A ready deployment remains in progress
while its build worker is active so a partial Compose outcome cannot be published as success.

The exact deployed commit is required. Missing revisions are never substituted with the
current branch head. Repository changes and organization mismatches stop delivery. All
execution targets use this same reporter. Controller quiescence prevents further writes.

`github/check-runs` is the shared transport for deployment and independent Actions Checks.
It uses the authorized organization's GitHub App installation with Checks write access.
It never substitutes a personal/CLI credential. Existing GitHub-owned workflow Checks are
still not duplicated. Delivery errors do not change or block deployment outcomes.

Each remote Check carries an external ID tied to its deployment attempt and mirror row.
If a creation response is lost, retry searches the commit for that identity before creating
another Check. Persisted payload digests avoid unchanged updates. Transient failures use
bounded backoff; unavailable access is retried every 15 minutes, up to seven days from
admission. The latest delivery error is visible in Project Source.

Disabling reporting closes Checks already created for an active attempt as neutral. It
also recovers accepted creations with lost responses without creating a new Check. Other
preference edits apply at the next admission.

## Failure details and reruns

Checks contain status and an Openship deployment URL. When enabled, bounded failure summaries
redact captured project/service environment values and sensitive diagnostic text. Full build
logs are not attached. The overall Check includes service failure reasons even when individual
service Checks are disabled. Repository readers can see the published summaries.

Signed `check_run.rerequested` deliveries resolve the stored Check, repository, organization
and exact commit. The overall Check uses normal whole-project admission; a service Check uses
the same admission with a selected service. Source changes, deleted services and disabled
reporting cannot authorize reruns. Admission errors reach the shared webhook delivery record
instead of being acknowledged as successful reruns.

## Validation and rollout

Regression coverage exercises real PGlite migrations/admission/leases, lifecycle projection,
partial failures, cancellation, opt-out, secret redaction, uncertain GitHub responses, scoped
reruns, HTTP/SDK settings parity, and wizard preference preservation. Browser verification
covers the Source controls across themes, narrow layouts and RTL.

Migration `0185_deployment_github_checks` extends the existing Check mirror table and adds
project preferences. Deploy it after migrations 0182–0184 in journal timestamp order. No
customer migration or historical deployment replay is performed.
