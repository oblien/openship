# Complimentary Cloud plans

New monthly servers require verified provider funding. The operator CLI cannot
purchase monthly capacity by granting namespace credits and rejects new grants
with `BILLING_CAPACITY_FUNDING_REQUIRED`. Arrange a funded or explicitly subsidized
capacity contract with Oblien instead; a zero customer price does not make the
infrastructure free. Ordinary monthly checkout remains provider-managed.

## Previously saved metered grants

Existing grants remain separate from hosted subscriptions. They retain their
saved application limits, resource policy and monthly credit allowance. Oblien
continues to meter usage under its Mode A policy/reset API; the operator's account
covers that consumption. No catalog change upgrades them to monthly capacity.

Run the CLI in the deployed API container so it uses that instance's PostgreSQL
database and Oblien credentials. It verifies the schema without running migrations
or opening another live PGlite connection.

```sh
docker compose exec api bun run --cwd apps/api billing:grant show --email user@example.com
docker compose exec api bun run --cwd apps/api billing:grant revoke --email user@example.com
```

The CLI selects an owned organization by email; `--organization <id>` and
`--workspace <id>` select another owned organization or managed server. Ambiguous
users, non-owned servers and grants that would replace hosted subscriptions are
rejected. `--operator <name>` records the responsible operator. No email or
organization is embedded in the implementation.

Repeating `grant` with the saved plan and duration, plus a reason and operator can
reuse that existing grant; it cannot create a new monthly plan. `--dry-run` makes
no writes. Revoking an old grant does not make a new grant purchasable.

The existing reconciliation job renews saved metered allowances at their monthly
anniversary. The provider deduplicates resets by period end. Reads do not reset
consumed credit; exhaustion still blocks new spending. Revocation or expiry removes
the allowance and restores the free policy while preserving usage and history.

The API exposes `complimentary` and a zero-price plan without fabricating a paid
subscription. Paid checkout requires revocation first. If an earlier checkout
settles, the hosted subscription supersedes the grant permanently; cancellation
does not resurrect it. Tenant settings and export/import cannot grant access.
