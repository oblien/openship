# Actions execution verification

Verified against the private sample repository
[Hydralerne/openship-independent-ci-verification-20261011](https://github.com/Hydralerne/openship-independent-ci-verification-20261011)
on 12 October 2026. GitHub Actions is disabled there, and its Actions run count
remained zero. Workflow code lives in `.openship/workflows/`.

## Live independent workflows

| Case                                                 | Result | GitHub Check                                                                                                  |
| ---------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------- |
| Native Mac, three workflow levels                    | Passed | [leaf job](https://github.com/Hydralerne/openship-independent-ci-verification-20261011/runs/114787855311)     |
| Temporary Cloud Linux, three workflow levels         | Passed | [leaf job](https://github.com/Hydralerne/openship-independent-ci-verification-20261011/runs/114787855127)     |
| Native Mac, HTTPS Openship OIDC in a called workflow | Passed | [identity job](https://github.com/Hydralerne/openship-independent-ci-verification-20261011/runs/114793285204) |

The reusable cases ran at repository commit `5b5ed0e`; the OIDC case ran at
`ed54198`. Each reusable run used two coordinator records and two real workers.
Coordinators did not allocate a runner or VM. The sample verified:

- private checkout at the immutable run commit and real Node project tests;
- boolean/number inputs, explicitly forwarded secrets and masked persisted logs;
- outputs forwarded through two call boundaries into a dependent root job;
- separate runner reservations, live logs and recovery with a new controller;
- successful Checks for the root, called workflows and executable jobs;
- removal of both temporary VMs, release of runner capacity and deletion of the
  isolated, quota-limited test namespace.

The OIDC case used the production token/discovery/JWKS routes over a local HTTPS
controller. A real native worker trusted a temporary test certificate, requested
an audience-bound token and verified its RSA signature against the published key.
It checked issuer, audience, organization, job, destination, revision, expiry and
called-workflow identity. The request credential was masked, and another request
with the same credential after completion returned 403. This verifies the issuer
and worker integration; it does not configure or exercise AWS/Azure/GCP trust.

## Regression gates

Platform/API coverage checks immutable imports, cycle and input validation,
permission reduction, explicit secret forwarding, repeated-reference pinning,
approval, nested cancellation, cleanup and restart-safe matrix limits. Calls do
not introduce a synthetic total timeout; each executable job keeps its timeout.
Full API boot and 19 real instance handoff/invitation/relay/privacy cases also pass.
The signing key is registered in the transfer cipher registry, re-encrypted for the
destination, and invalidated in the shared post-import cache boundary. Public keys
remain available when credentials are intentionally omitted; signing then fails
with a recovery message instead of replacing the imported identity.
OIDC tests cover encrypted key persistence, racing initialization, signature and
audience validation, expiry, wrong capabilities, queued/cancelled/finished jobs,
foreign organizations and revoked destination access.

Dashboard coverage checks all three destination choices, workflow-draft
preservation, nested job selection/logs, notification setup and delayed/nested
modal focus. Browser checks cover light, dim, mobile and Arabic layouts, shared
server acquisition, temporary funding and keyboard closure. The existing server
purchase UI was exercised with fixture responses; no permanent server purchase
was made for these tests.

The Go worker tests, race suite and vet pass. API/dashboard typechecks, database
upgrade and full-instance dump/restore tests, SDK/CLI packaging, documentation
coverage and structured-error boundary audit are required before publishing.
The combined release PR records CI for the integrated Actions, Cloud build and
dashboard changes. PR #1116 retains the original execution evidence.

## Release boundaries

OIDC providers must trust the Openship issuer and appropriate organization,
repository/ref and workflow subjects. Protected environments remain delegated to
GitHub-coordinated workflows. Linux and native macOS are supported; Windows and
GitHub Enterprise runner destinations are not available.

The combined branch includes Cloud migrations `0182`/`0183` before Actions
migrations `0184`–`0187`, with their original increasing timestamps. Publish this
complete journal together; do not deploy the later Actions migrations on their
own. No production deployment was part of this verification.
