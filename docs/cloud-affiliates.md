# Cloud affiliates

OpenShip presents an account-owned affiliate program over Oblien's existing
referral checkout, invoice, refund and wallet machinery. OpenShip does not keep
an earnings ledger, mint credits, process cash transfers or trust client-supplied
beneficiaries. The provider extension is required; enabling the UI flag against
an older provider is not sufficient.

## Customer workflow

1. Open **Affiliates** and join the configured program.
2. Create a named link for all eligible Cloud plans or a specific VM capacity.
   Choose the buyer discount, optionally set an expiry, and copy the link or code.
   The discount is subtracted from the commission budget: 20% total with a 5%
   buyer discount leaves 15% for the affiliate, calculated from the eligible
   pretax subtotal in integer cents. Prices and eligibility are rechecked by the
   provider, including for codes entered on its hosted payment page.
3. The public `/r/AF-…` page shows eligible plans from the live Cloud catalog using
   the shared pricing cards. Selecting a plan preserves its interval and referral
   through signup/login into the normal checkout flow. The discount is verified
   again before checkout; an invalid referral cannot silently start a full-price
   purchase. The plan picker supports manual code entry and removal. There is no
   tracking cookie or silent attribution after the user leaves this flow.
4. The provider reserves immutable terms before starting checkout. A link's
   revocation stops new reservations; it does not rewrite accepted checkouts or
   already acquired subscriptions.
5. Referred customers use stable anonymized labels. The page shows verified paid
   cycles, paid-through dates, renewal status, reward expiry and payment history.
   It does not disclose another customer's email, projects or payment credentials.
6. Available cash earnings equal credited commission minus pending/processing
   reservations and previously paid payouts. Refunds reduce credited commission.
   The initial minimum is **$50**; an operator can override an individual's limit.
   The Request payout action appears once the enabled participant's available
   balance meets that minimum. It opens a dialog; payout history and cancellation
   remain available independently of the balance.
7. A cash request reserves the amount in Oblien and the reseller wallet in one
   transaction. Users can cancel only pending requests. OpenShip reviews and pays
   externally, then records the transfer reference. The software does not send
   money automatically or collect bank details in referral links.

Only monthly or annual prepaid Cloud VM subscriptions qualify. The minimum list
price is $10 monthly equivalent ($120 for an annual invoice). Manage subscriptions,
PAYG, credit top-ups, plan-change prorations and free plans do not acquire referrals.
Renewals keep the original reward expiry; changing a plan cannot restart it.
Subscription cancellation affects future renewal, not the already paid period.

## Identity and concurrency

The provider owns records by Stripe environment, reseller account, program
namespace and participant key. OpenShip derives a stable SHA-256 participant key
from the authenticated user ID. A program namespace categorizes the reseller's
single account wallet; it is not a separate wallet or payment channel.

API, remote SDK and the native bridge use the same contracts and identity gate.
Project/organization-bound credentials cannot access personal earnings. A team
member can access their own account, regardless of their team's billing rights.
Membership and credential restrictions are refreshed on every operation. Desktop
HTTP requests use the person's linked Cloud credential. Fixed native SDK scopes
cannot widen local authority to Cloud; connect the remote SDK to Cloud instead.

The saved subscription checkout contains the authenticated buyer key and the
current workspace members' keys. The provider rejects self-referrals and referrals
from members of the buying workspace. No identity, price, commission or namespace
is accepted from the browser. Workspaces with more than 100 members need operator
review to apply a code; normal purchases still work. Independent-account collusion
cannot be proved from these identities; manual payout review remains necessary.

Provider settlement and payout writes share the participant mutex and wallet lock.
Requests have a persistent idempotency key and immutable amount. A retry cannot
reserve twice. Refund jobs awaiting reconciliation block new requests and approval.
Cancel/reject releases a reservation once; paid never releases it. Approval checks
current net earnings. Recording an external transfer after approval remains possible
if a later refund arrives, so accounting can reflect money already sent. Subsequent
requests remain blocked by the reduced available balance. The provider records
state transitions with its existing transactional billing event outbox.

The dashboard resets private lists, dialogs and drafts when account/Cloud scope
changes. Delayed responses cannot populate another account. Public link endpoints
expose only commercial terms. Private responses are not cached.

## Rollout

1. Integrate the provider's affiliate base implementation and reseller extension
   with the currently deployed backend. Do not deploy an older branch over newer
   security or billing fixes. The provider extension includes the already deployed
   annual-capacity semantics so annual Cloud checkout remains consistent.
2. Apply the idempotent affiliate migration and run the provider recovery worker.
3. Create an explicit reseller policy through Oblien's existing MFA-protected
   operator workflow. Bind it to the OpenShip enterprise account and the `openship`
   program namespace. Set `reseller: true`, `minimumMonthlyCents: 1000` and
   `payoutMinimumCents: 5000`. Commission budget and duration come from that policy;
   they are not granted by the OpenShip deployment.
4. Deploy OpenShip with `AFFILIATES_ENABLED=false`. Check provider compatibility,
   namespace ownership, redirect origins, policy and settlement workers.
5. Enable `AFFILIATES_ENABLED=true` and set `OBLIEN_AFFILIATE_NAMESPACE` to that
   policy's namespace. Exercise an isolated provider test environment before
   accepting live affiliate purchases. Existing normal billing does not require
   the affiliate feature flag.

There is no launch-time policy seeding, wallet mutation or automatic payout.
Pausing a participant in Oblien stops new links, referral reservations, payout
requests and approvals while keeping their history visible. Existing accepted
contracts still settle. Disabling the OpenShip flag stops the product surface;
existing provider receipts and obligations must continue to reconcile.

## Operator commands

Run inside the trusted Cloud API deployment with its normal PostgreSQL and Oblien
configuration. The command verifies the schema and does not run migrations or open
an embedded database. There is no tenant-facing approval endpoint.
Docker includes Node and tsx; run from `/app` using `npm --prefix apps/api run
affiliate -- <command>`. A bare source release includes the scripts and supports
`bun api/scripts/affiliate.ts <command>` from its release directory.

```sh
npm --prefix apps/api run affiliate -- queue --status pending
npm --prefix apps/api run affiliate -- queue --status processing --limit 25 --offset 0
npm --prefix apps/api run affiliate -- show --email partner@example.com
npm --prefix apps/api run affiliate -- configure --email partner@example.com \
  --minimum-cents 5000 --enabled true --reason "Approved payout terms"
npm --prefix apps/api run affiliate -- approve --email partner@example.com \
  --payout <request-id> --reason "Verified recipient and available earnings"
npm --prefix apps/api run affiliate -- reject --email partner@example.com \
  --payout <request-id> --reason "Purchase refunded before transfer"
npm --prefix apps/api run affiliate -- paid --email partner@example.com \
  --payout <request-id> --reference <external-transfer-id> --reason "Transfer completed"
```

`approve` changes pending to processing, preventing user cancellation. Review the
request in the staff-only queue, which reads the provider's ledger for the
configured program. It shows payout IDs, amounts, participant keys, matching
account emails and review/transfer references. It is never exposed through the
customer API, SDK or MCP. Deleted accounts have no account mapping; use
`--participant-key <key>` instead of `--email` to reconcile their existing requests.
Account lookup derives the same participant hash without adding another registry.

Before payment, verify the beneficiary and complete the external payment using the request ID as the payment
system's idempotency/reference key. Only then use `paid` with its actual reference.
Retrying the same command/reference is safe; a different reference for an already
paid request is rejected. Reusing one transfer reference for another payout is also
rejected, including concurrent recordings. `reject` is only appropriate if no
external payment was made. A database transaction cannot make a manual bank transfer atomic: never resend
money because recording its completion timed out. Reconcile the external receipt.
Use `show --offset 100` for the next payout page. Operator identity and reason are
recorded at the provider; `--operator` overrides the current OS username.

### Plan and billing restrictions

Offer creation is a two-step form. `eligiblePlans: null` (or absent on a legacy
link) keeps the program's eligible scope. An explicit list contains capacity-based
plan IDs and `monthly` / `annual` intervals. It must contain at least one unique
plan, with nonempty, unique intervals. The provider intersects this list with the
policy's plan restriction and validates the actual saved capacity and billing
interval inside the locked referral reservation. It normalizes its internal
`yearly` interval at that boundary. The public landing page filters the same
combinations and chooses the only available interval automatically. Changing
browser URLs cannot widen an offer's eligibility.

The earnings matrix uses current catalog list prices and the existing per-invoice
rounding for an estimate: round the commission budget, round the buyer discount,
then subtract. Annual amounts are for the full annual invoice. Actual commission
continues through the verified receipt and refund pipeline.

### Manual payout destinations

Configure `AFFILIATE_PAYOUT_ENCRYPTION_KEY` on the **Oblien provider**, using a stable
64-character hexadecimal key generated with `openssl rand -hex 32`. Back it up
with the database. This is separate from the OpenShip API and its normal database
credentials. The idempotent affiliate migration adds encrypted destination columns
to participants and payout requests. Missing configuration blocks destination
writes without affecting normal Cloud purchases or legacy payout history.

PayPal, bank transfer, Wise and Payoneer are recipient methods for manual review.
They are not automatic payment integrations. Bank transfers can be sent from
Mercury using ACH, domestic wire or international wire, as the destination allows.
PayPal supports email / PayPal.Me recipients; Wise's email flow and Payoneer's
payment-request flow depend on recipient and funding eligibility. For a card-funded
Payoneer payment, arrange a payment request with the affiliate after approval.
Review the available funding options in the provider before sending money:

- [Mercury sending money](https://support.mercury.com/hc/en-us/articles/28772488555668-Sending-money-overview)
- [PayPal sending money](https://www.paypal.com/us/cshelp/article/how-do-i-send-money-help293)
- [Wise email recipients](https://wise.com/help/articles/2932105/how-can-i-send-money-to-an-email-address)
- [Payoneer payment requests and card funding](https://payoneer.custhelp.com/app/answers/detail/a_id/17183/kw/get)

Destination details use the existing AES-256-GCM encryption utility, with an
identity binding inside the authenticated payload. Account and payout list views
receive only a masked summary and revision. Request creation locks the participant,
checks the displayed revision, and copies the encrypted destination into the same
transaction as the reservation. Existing request retries retain their snapshot;
subsequent account changes cannot redirect a pending or approved request.

Staff retrieves a request's full destination explicitly, with an audited reason:

```bash
npm --prefix apps/api run affiliate -- destination \
  --email partner@example.com --payout <request-id> \
  --reason "Verify recipient before manual payment"
```

This private operator command is unavailable through customer HTTP, SDK or MCP
operations. Queue and ordinary show commands retain masked details. Legacy requests
without a snapshot return no destination and require direct recipient verification.
Approval and recording a completed transfer still use the same existing commands;
none of these commands sends money or accepts card numbers or passwords.
