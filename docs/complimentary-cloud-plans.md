# Complimentary Cloud plans

The SaaS operator can grant a catalog plan without charging the customer. Run the
CLI in the deployed API container so it uses that instance's PostgreSQL database
and Oblien credentials. Deploy migration `0146_billing_plan_grant` and the API
changes before using it. The CLI verifies the deployed schema; it does not run
migrations or open a live PGlite database.

Preview and issue a grant:

```sh
docker compose exec api bun run --cwd apps/api billing:grant grant \
  --email user@example.com --plan pro --reason "Partner account" --dry-run

docker compose exec api bun run --cwd apps/api billing:grant grant \
  --email user@example.com --plan pro --reason "Partner account"
```

The default is monthly renewal until revoked. Repeating the same command reuses
the existing grant and preserves credits already consumed. `--expires` accepts a
future ISO timestamp, such as `2026-11-01T00:00:00Z`. A different plan or duration
requires revoking the existing grant first.

Inspect or revoke:

```sh
docker compose exec api bun run --cwd apps/api billing:grant show --email user@example.com
docker compose exec api bun run --cwd apps/api billing:grant revoke --email user@example.com
```

The CLI resolves the email case-insensitively and selects its personal owned
workspace. Use `--organization <id>` for another owned workspace. Ambiguous users,
non-owned workspaces, and existing hosted/legacy subscriptions are rejected.
`--operator <name>` overrides the OS username recorded with the mandatory reason.
No email or organization is embedded in the implementation.

The saved grant contains the catalog's application limits, resource policy and
monthly credit allowance at issuance. Oblien continues to meter usage and enforce
the namespace budget. This uses Oblien's Mode A policy/reset API; ordinary paid
subscriptions remain on Mode B. The customer's price is zero, and the operator's
Oblien account covers the actual resource consumption.

The existing five-minute billing reconciliation job and normal entitlement checks
renew each complimentary allowance at its monthly anniversary. The provider uses
the period-end timestamp to deduplicate resets, including retries after a crash.
Ordinary reads within the period do not reset credits. Exhaustion still blocks
new Cloud spending. Revocation/expiry removes the grant's allowance and restores
the free resource policy; it preserves provider usage and purchased-credit history.

Grants are separate from hosted subscriptions: the application reports a
`complimentary` record and a zero-price plan, with no fabricated subscription or
payment. Paid checkout is disabled until the operator revokes the grant. If a
previously opened checkout completes, the hosted subscription permanently
supersedes the grant. Cancellation cannot resurrect it.

Only an operator with database/provider access can issue grants. Tenant settings,
organization metadata, and instance export/import cannot grant this entitlement.
Keep these source changes in subsequent API builds so persisted grants continue
to reconcile after a redeployment.
