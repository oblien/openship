# Cloud Actions billing

Cloud Actions uses one prepaid balance for temporary VMs and their internet
transfer. It is separate from monthly application-server subscriptions. Deposits
are $5, $20, $50 and $100; each dollar buys 100 provider credits. There is no
Actions subscription, fixed job-minute charge or separate transfer allowance.

## Usage and estimates

Oblien is the only usage meter and spending authority. Openship reads its live
`/pricing/calculator` rates for the credit-metered VM product, not preview rate
cards or monthly capacity prices. The API validates the 100-credits-per-dollar
conversion before offering checkout. Missing or invalid prices remain unavailable;
they never fall back to a hardcoded quote.

The three Linux profiles are 2 vCPU / 4 GiB RAM / 40 GiB temporary disk,
4 / 8 / 80 and 8 / 16 / 160. The UI shows estimated VM minutes for a selected
deposit, assuming full CPU and memory use, before transfer or disk I/O. CPU time
is active vCPU-minutes; memory is measured GiB-minutes. Uploads and downloads
consume the same balance at the current provider rate. These estimates do not
replace Oblien's actual metering, discounts or ledger.

VM preparation, failed workflow execution and cleanup can consume credits while
the VM uses resources. A queued job has no VM. Provider balance reads can lag
recent usage. Zero overdraft and stop-on-exhaustion are enforced by Oblien; do not
promise an instantaneous cutoff or derive customer charges from guest timestamps.
Artifacts and caches use the customer's configured destination.

`getActionsBudget` reads the provider balance and used credits, and never subtracts
job durations or local reservations. The local financial records mirror verified
net deposits and payment history only. The unused execution-second ledger has
been removed. Provider failures show an unavailable balance rather than zero or
an invented spendable amount.

## Payment and runner readiness

`ActionCredits` saves the complete checkout request before provider I/O. Retries
use the saved request, provider idempotency key and encrypted payment URL. A
browser redirect, webhook amount, open checkout or pending fulfillment cannot
fund an account. A namespace-scoped provider receipt must identify the saved
checkout. Net grants reconcile absolutely, so duplicate delivery cannot credit
twice and a refund cannot erase another deposit.

Before checkout, the budget exclusively owns a deterministic Actions namespace.
The shared namespace setup verifies zero included credit, no overdraft and
stop-on-exhaustion. It starts with zero resource capacity and rejects an existing
subscription, monthly capacity contract, ambiguous owner or unsafe policy.
Preparation never resets provider usage or credits.

After verified funding, payment recovery opens bounded namespace capacity and
saves three runner profiles through the same pool configuration used by operator
runners. The organization has two concurrent Cloud jobs across all sizes, not
two per size. The provider caps per VM at the largest profile and the aggregate
at two such VMs. Returned ownership and effective limits are verified before
profiles are enabled. No VM is created until a workflow job is admitted.

Payment and setup are separate checkpoints: confirmed deposits stay visible even
when capacity setup fails. The UI shows automatic setup retries. Public receipt
reads can mirror a payment and queue setup, but cannot provision resources. If setup fails or the
process dies, the purchase remains scheduled for retry. The catalog checkpoint
is saved only after all profiles exist. Replaying setup changes no credits and
opens no second checkout. Every VM admission still requires a fresh positive
provider balance; refund or exhaustion cannot be bypassed by a saved profile.

Signed payment events queue a receipt check and acknowledge delivery in the same
transaction. The existing recurring job runner handles up to 20 due purchases per
minute with four concurrent checks per process, independently of workflow
monitoring. Claims are persisted before I/O. Failures back off from 30 seconds
to five minutes; open payments are checked after five minutes, pending payment
or setup after one minute, and settled receipts daily for missed refunds.
Expired payments stop polling unless another signed event arrives.

The native SDK and HTTP API share billing authorization. Workflow permissions do
not grant financial access. Public budgets omit namespace identifiers, provider
requests and payment URLs. The Cloud payment gate requires configured provider
credentials, `BILLING_ENABLED` and valid live rates. Self-hosted runner execution
never opens a Cloud budget or calls payment reconciliation.

## Execution and cleanup

Funded profiles reuse `ActionController`, `ActionsWorker` and the authorized
`CloudWorkspaceExecutor`; there is no customer-specific execution engine. Each
job gets a namespace-scoped client, one stable VM creation key, a bounded TTL,
SSH disabled and no public service route. Only the authenticated Runtime API port
is exposed for control. Job containers receive no provider credential. They can
use their private disposable VM's Docker daemon for image-build actions; the VM
is the isolation and resource boundary. Cleanup confirms the VM is absent before
releasing its shared pool slot.
A stopped, exhausted VM produces an actionable Actions-budget error rather than
silently restarting or waiting until the entire job timeout.

Connected Linux and macOS destinations use the same controller and worker over
the server's execution adapter. Their jobs do not debit the Actions balance.

## Operator pools

`OPENSHIP_ACTIONS_CLOUD_POOLS` remains available for separately funded internal
test pools. Each namespace belongs to one configured organization. Operator
configuration cannot overwrite a customer-funded Actions namespace or a managed
server namespace, and removing an operator pool does not disable customer
profiles. In-flight configuration stays immutable until cleanup.

## Verification boundary

Automated tests cover the real database, signed webhook ingestion, native and
HTTP authorization, immutable checkout retries, refunds, setup recovery, live
pricing validation, aggregate admission, UI account switching and migrations.
Live-provider verification exercises temporary VM creation, Docker workflows,
usage reads, recovery and confirmed deletion with isolated test funding. A
simulated paid receipt or operator test allowance is not a real Stripe payment;
report that distinction in release verification.
