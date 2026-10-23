# Request body limits per domain

On self-hosted nginx/OpenResty edges, domains attached to the same project or
service can use different incoming HTTP request body limits. For example, an API
domain can accept `2m` while a Socket.IO domain accepts `1m`.

The effective limit comes from the domain override, then the project proxy
settings, then the installed Edge HTTP default. The standard Edge default remains
`50m`. An inheriting domain does not store or render a copy of that default, so
later project changes affect it automatically. Other project proxy settings still
apply to both domains. There is no service-level or path-level override.

In a domain's **Request body limit** control, select **Inherit project** or
**Custom**. Custom sizes use a positive integer followed by lowercase `k`, `m`, or
`g`, in binary units (one `m` is 1,048,576 bytes). The deliberate value `0` means
**Unlimited**. Expanded sizes must fit JavaScript's safe integer byte range;
malformed values and arbitrary nginx text are rejected.

The CLI can set or clear an override:

```sh
openship domain update <domain-id> --client-max-body-size 1m
openship domain update <domain-id> --inherit-client-max-body-size
```

The API accepts `PATCH /api/domains/<domain-id>`:

```json
{ "proxy": { "clientMaxBodySize": "1m" } }
```

Omitting `proxy` leaves it unchanged. `{"proxy":null}` restores inheritance.
An object replaces the override object; `{}` also has no explicit limit.
Unknown keys are rejected. The SDK exposes the same operation on the domain
resource. Cloud and providers that cannot apply native body limits return an
explicit capability error.

Saving a desired value is separate from applying it. Deployment, routing retry,
and live edits resolve the saved domain value before registering the route.
Certificate activation and restart repairs replay the resolved route. Config
validation or reload failure keeps the previous vhost and replay state; retry
after correcting the error. Read-back shows the saved override, effective value
and source, the value observed in the edge configuration, and whether that
configuration matches the resolved value. An unreadable edge or an unobserved
inherited HTTP default is reported as unknown. Configuration read-back is not a
request probe of a running nginx worker, so a matching file is never treated as proof
that the running workers use the value.

These limits apply to incoming HTTP bodies, including chunked requests and
Socket.IO polling POSTs. They do not limit response sizes, throughput, or
WebSocket frames after upgrade; retain the application's message-size limit.
Existing rate rules and their path selection remain independent.

The additive database migration leaves existing domains with no override. Project
exports retain explicit overrides and inheritance separately. Clear overrides and
reconcile routes before downgrading to a version that does not understand them.

For a reproducible local traffic check, see
[`scripts/fixtures/domain-body-cap/`](../scripts/fixtures/domain-body-cap/).
The fixture uses disposable origins and loopback ports; it requires no deployed
server changes.
