# Request body limits per domain

On self-hosted nginx/OpenResty edges, domains attached to the same project or
service can use different incoming HTTP request body limits. For example, an API
domain can accept `2m` while a Socket.IO domain accepts `1m`.

In a domain's **HTTP body limit** control, select **Inherit project** or
**Custom**. The control labels `0` as **Unlimited (0)** and displays the saved value,
effective value, source, observed configuration, and configuration comparison.
Use **Refresh status** to read the configuration again after a save or routing retry.

See the [domain API reference](../apps/web/content/docs/api/domains.mdx#set-a-domain-http-body-limit)
for size syntax, inheritance, provider support, save/retry behavior, and read-back
semantics, including paused and pre-deployment projects. For command syntax, see
the [CLI reference](../apps/web/content/docs/cli/reference/domain/index.mdx#openship-domain-update).

The additive database migration leaves existing domains with no override. Project
exports retain explicit overrides and inheritance separately. Clear overrides and
reconcile routes before downgrading to a version that does not understand them.

For a reproducible local traffic check, see
[`scripts/fixtures/domain-body-cap/`](../scripts/fixtures/domain-body-cap/).
The fixture uses disposable origins and loopback ports; it requires no deployed
server changes.
