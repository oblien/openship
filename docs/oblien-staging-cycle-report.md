# Oblien staging customer-cycle report

Rechecked 2026-09-17 after Oblien's billing fixes, using the newly supplied
staging credentials and SDK 2.3.2. Onboarding, Docker metering, customer isolation,
billing shutdown and manual suspension pass live tests. Customer launch remains
gated by permission to publish on `opsh.io` and the deployed payment/webhook
acceptance cycle. No payment was made.

The final two-customer isolation/lifecycle run passed **52/52 checks** at
04:31:33 UTC. Its namespaces, VMs and Pages were deleted. The Docker deployment
run passed **31/31 checks** on the preview domain; `opsh.io` publishing still fails.

## Verified after the provider fixes

| Contract | Live result |
| --- | --- |
| Immediate onboarding defaults | Both namespace create and ensure inherit zero quota, zero overdraft, zero suspend threshold, and `stop_workspaces`; unpaid compute is refused |
| Namespace entitlement ownership | New unpaid namespaces have no subscription, no paid billing period, and no inherited account-owner tier |
| Idempotent onboarding | Repeating ensure preserves the namespace ID and its existing finite allowance |
| Concurrent workspace cap | Two simultaneous creates against a one-workspace ceiling produce exactly one VM; an independent raw HTTP request confirms a 409 refusal |
| Resource ceilings | CPU, memory and disk resize requests above the namespace's caps are rejected |
| Customer isolation | Scoped tokens cannot read, stop or delete another customer's VM, escape their namespace on create, read another customer's Page, grant credit or mint privileged tokens |
| Docker billing meter | CPU/memory usage produces usage records and consumes namespace credit |
| Usage-driven exhaustion | Starting with positive credit, subsequent usage exhausts the allowance and automatically stops the VM; the other customer's VM stays running |
| Billing suspension controls | Scoped inspection, repeated Stop and Delete work; Start and replacement creation are rejected |
| Credit restoration | Increasing credit restores billing access without starting compute; an explicit Start resumes the same VM |
| Manual suspension controls | Credit increases preserve the suspension; Start needs explicit namespace reactivation; scoped Stop and Delete work |
| Manual shutdown | Both suspensions stopped the VM in the final 04:31 UTC test, including after billing restoration and explicit restart |

The first post-fix run recorded 0.2039 CPU minutes, 0.1093 memory GB-minutes,
and 0.3277 credits at 03:43:44 UTC. The fixture then had a positive balance of
0.0623 credits. Subsequent usage exhausted that balance and the VM was stopped
by 03:44:43 UTC. A second isolated run also passed usage-driven exhaustion.
These checks exercise the actual meter; setting the allowance to zero is not
used as proof of usage-driven exhaustion.

The complete Docker test passed all 31 live checks again with SDK 2.3.2 at
03:51:05 UTC on `preview.oblien.com`: one VM per stack, source builds inside the VM, private
service DNS, two public HTTPS ports, streaming logs, volume backup/restore,
updates, retained-image rollback, container and VM restart, and route/resource
cleanup. SDK 2.3.2 also passes 77 targeted adapter tests, 158 API billing/quota
tests and 77 API teardown/workspace tests, plus API and adapter type checks.

The provider now returns `accepted:true` while workspace deletion is in progress.
Openship's runtime waits for a scoped 404 before completing teardown; timeout or
failed inspection leaves cleanup retryable. The live runtime confirmed deletion
during both manual and billing suspension at 04:27–04:28 UTC. Acceptance scripts
also wait for the workspace to disappear from the scoped list. The earlier
immediate-list assertion was a test timing error, not a provider deletion refusal.

## Remaining Oblien finding: `opsh.io` permission

Actual Page/route registration returned `403 domain_not_allowed` at
04:29:27 UTC using SDK 2.3.2. Slug availability is insufficient: this fails the
real Docker deployment's public routing step. Grant the intended account
permission to publish on the Openship domain, including its edge/DNS/TLS setup.
The failed routing test cleaned up its namespace, VM and Page candidates.

## Earlier manual-shutdown observation: passed on the final recheck

At 03:49 and 03:51 UTC, manual suspension of `os-cycle-45195767d99e47-a`
(workspace `de6fecad8998294e`) returned `stopped:0`. Its VM continued reporting
`running` for 120 seconds while the namespace was suspended. Explicit Stop
succeeded, and credit increases correctly preserved manual suspension.

This did not reproduce in the final full cycle. At 04:31:02 and 04:31:05 UTC,
both manual suspensions of `os-cycle-36a7ac81a18040-a` (workspace
`c8ffe7ef01bbd59e`) returned `stopped:1`; immediate scoped inspection confirmed
`info.status:stopped` and `info.is_running:false`. Explicit activation did not
start the VM; the subsequent customer Start succeeded. No Openship workaround
was used for these shutdowns. This is no longer listed as a current blocker.

## Openship release work still required

The code is wired to the updated provider, but local tests are not a complete
customer launch certification. Deploy the API/worker and apply the documented
migrations. Once that API has a public HTTPS origin, use its
`/api/billing/oblien-webhook` endpoint, configure the signing secret, and verify
actual provider delivery. Callback handling has been tested internally; no
public staging API exists yet.

Complete two isolated test-customer checkout, portal, payment-method/invoice,
renewal/cancellation/resumption and credit-pack cycles. Include duplicate events,
missed webhook reconciliation, plan replacement and public project deployment.
Finite policy grants used by the infrastructure tests do not establish a paid
subscription or exercise checkout. Purchases remain disabled until these gates
pass. See [the release checklist](./openship-cloud-launch.md).

The read-only readiness checker now passes provider catalog, default policy,
namespace subscription/entitlement agreement and finite allowance. It still
reports the missing signed public callback and disabled purchase flags.

## Reproduce

From the repository root, use a private file containing the confirmed staging
`OBLIEN_CLIENT_ID` and `OBLIEN_CLIENT_SECRET`:

```sh
bun packages/adapters/scripts/verify-cloud-isolation.ts --staging-env /path/to/staging.env
bun packages/adapters/scripts/verify-cloud-docker.ts --staging-env /path/to/staging.env --public-domain opsh.io
```

The scripts create disposable capped fixtures and clean them up in `finally`.
They do not change account defaults or existing customer policies/usage. The
isolation test preserves failed checks and its failing exit status while using
explicit fixture controls to continue independent cleanup/reactivation checks.
Resource manifests and check reports are private local files.

Sources: [billing API](https://oblien.com/docs/api/billing),
[namespace API](https://oblien.com/docs/api/namespaces),
[usage metering](https://oblien.com/docs/concepts/billing).
