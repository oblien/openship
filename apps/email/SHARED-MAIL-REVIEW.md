# Shared mail server release review

**Ready for a controlled two-workspace staging review. Hold general availability of shared inboxes.** Customer SQL now runs under a separate PostgreSQL login for each workspace. Two remaining behaviors affect customers directly.

| Finding | Customer impact | Release criterion |
| --- | --- | --- |
| Reusing a deleted address | Webmail templates use the email address as their owner. Jobs and grants use an identity derived from the instance, address, and mail hosts. Deleting a mailbox through the worker removes the engine account and attempts Maildir cleanup. Creating the same address again can associate a new user with surviving webmail records. Reservations prevent another workspace from claiming the domain. They do not distinguish two successive users in the same workspace. | Give each mailbox creation a distinct identity, or complete and record webmail cleanup before reuse. Exercise delete, recreate, and interrupted cleanup with two successive owners. |
| Hosted outbound message formats | A customer can receive incoming replies and attachments. The managed outbound path rejects attachments and messages carrying threading headers, including ordinary replies from webmail. The installed Oblien transport documents text and HTML delivery and omission of extra headers. | Demonstrate delivery of a threaded reply and an attachment through the tenant's managed sending path before advertising a full hosted mailbox. |

The review covers the first-party webmail server, the shared administration path in Cloud and the worker, and the relevant mail engine configuration. The inventory below names every file under `apps/email/server/src`. Upstream daemon implementations, the provider’s service, and running production hosts are outside this source review.

## Tenant boundaries

| Operation | Enforcement and evidence |
| --- | --- |
| Authenticate a worker request | The worker checks the token hash, parent PAT, organization, service header, route namespace, and server. Only the validated tenant credential selects a customer database login. The host operator remains trusted. [Worker authentication](../api/src/middleware/auth.ts), [tenant enrollment](../api/src/modules/mail/tenant-access.ts) |
| Read or mutate customer SQL | Row policies on eight tables bind rows to the database login. Ownership reservations are read-only for that login. Grants exclude mailbox password reads, domain transport changes, and table truncation. Domain creation requires verified DNS and a permanent host-side reservation. A failed creation can be retried by the verified owner. [Policies and column grants](../../packages/platform/src/engine/modules/mail/admin/tenant-database.ts), [ownership](../../packages/platform/src/engine/modules/mail/admin/tenant-domains.ts) |
| Construct SQL | Webmail uses Drizzle bindings and fixed SQLite bootstrap statements. The remote worker sends SQL through psql. Its serializers quote text, handle both PostgreSQL backslash settings, reject NULs, and constrain numeric values. Customer namespace identifiers use a strict fixed-format allowlist. [Worker SQL transport](../../packages/platform/src/engine/modules/mail/admin/psql-runner.ts), [regression coverage](../api/test/modules/managed-mail/worker.test.ts) |
| Count inbox messages | The worker builds the Dovecot roster using customer-scoped SQL. Results are checked against that roster and the cache distinguishes workspaces. A missing count stays unknown. [Inbox counts](../api/src/modules/mail/admin/inbox-counts.ts) |
| Access mailbox files | Creation checks the canonical mailbox tree on the engine. Shared hard deletion checks the stored domain, rejects path traversal and checks the canonical path before removal. Maildir cleanup failure can leave files for the operator after the login has been removed. [Maildir](../../packages/platform/src/engine/modules/mail/admin/maildir.ts), [mailbox CRUD](../../packages/platform/src/engine/modules/mail/admin/mailboxes.service.ts) |
| Receive or submit messages | Dovecot enforces private namespaces. Authenticated SMTP submissions use per-tenant relay identities. Webmail binds managed sending to the authenticated mailbox, verified domain and configured API authority. Postfix, Dovecot, their operators and the control plane are trusted parts of the shared service. [IMAP policy](../../packages/platform/src/engine/modules/mail/admin/shared-imap.ts), [relay policy](../../packages/platform/src/engine/modules/mail/admin/shared-relay.ts), [relay transport](docker/api-relay.py) |
| Restore the database | Shared database archives include the unprivileged policy group required by PostgreSQL on a fresh cluster. Workspace login roles are provisioned by enrollment. Older worker credentials can fail closed until the next enrollment on the restored host. [Backup plan](../../packages/platform/src/engine/modules/mail/backup-plan.ts) |

## Webmail server file inventory

Paths in this table are relative to `apps/email/server/src`.

| File | What the review checked |
| --- | --- |
| [ctx.ts](server/src/ctx.ts) | IMAP and SMTP credentials derive from the resolved browser session. |
| [db/bootstrap.ts](server/src/db/bootstrap.ts) | SQLite bootstrap executes fixed DDL. Existing databases require compatibility with the declared schema. |
| [db/index.ts](server/src/db/index.ts) | Opens the configured SQLite database and enables WAL and foreign keys. Database and WAL volumes contain private customer data. |
| [db/schema.ts](server/src/db/schema.ts) | Verified owner columns for sessions, preferences, grants, jobs, and assistant state. Address reuse is the lifecycle issue above. |
| [env.ts](server/src/env.ts) | Production requires secrets. Development-generated keys are written to a local file. Managed sending requires a configured authority. |
| [main.ts](server/src/main.ts) | Checked public and private mounts, request body limit, CORS, static roots and Bun request context. The HTTP handler now passes the socket server to Hono. |
| [lib/audit-log.ts](server/src/lib/audit-log.ts) | Authentication events are structured and appended to a private file. The operator still handles log retention. |
| [lib/blocked-senders.ts](server/src/lib/blocked-senders.ts) | Sieve updates serialize by mailbox and preserve the previous active script. |
| [lib/branding.ts](server/src/lib/branding.ts) | Config and assets come from operator-selected paths. Branding is instance-wide, so it must contain public information only. |
| [lib/client-ip.ts](server/src/lib/client-ip.ts) | Direct listeners use Bun’s socket peer. The catalog enables `TRUST_PROXY=true` behind the OpenShip edge, which overwrites `X-Real-IP`. Restrict origin access to that proxy when enabling this setting. |
| [lib/cookies.ts](server/src/lib/cookies.ts) | Defines consent preferences and defaults. It does not issue login credentials. |
| [lib/crypto.ts](server/src/lib/crypto.ts) | AES-GCM protects stored credentials. Job and grant data use associated data. Cookie signatures use keys derived for each cookie name. |
| [lib/imap-driver.ts](server/src/lib/imap-driver.ts) | Traced folder selection, UID lookup, reads, flags, deletes, attachment parsing and Sent append through mailbox-authenticated connections. Folder aliases now match own properties only. |
| [lib/imap-errors.ts](server/src/lib/imap-errors.ts) | Distinguishes invalid credentials from TLS and connection failures. The distinction controls session eviction. |
| [lib/imap-idle.ts](server/src/lib/imap-idle.ts) | IDLE owns a connection for the SSE lifetime. Abort or disconnect closes it. Mailbox change notifications are coalesced. |
| [lib/imap.ts](server/src/lib/imap.ts) | IMAP uses TLS or required STARTTLS. Connection errors, deadlines and teardown have explicit handling. |
| [lib/index-html.ts](server/src/lib/index-html.ts) | Reviewed text, attribute and embedded JSON output. Operator strings containing dollar replacement markers are now inserted literally. |
| [lib/outbound.ts](server/src/lib/outbound.ts) | Checks pinned host, mailbox sender and configured domain key. Generates an idempotency key. Hosted mail rejects unsupported messages before SMTP dispatch, including installations with legacy provider credentials. |
| [lib/rate-limit.ts](server/src/lib/rate-limit.ts) | Evicts expired per-key buckets. Limits are process-local, a deployment assumption for a single webmail process. |
| [lib/request-origin.ts](server/src/lib/request-origin.ts) | One origin check is shared by session mutations, tRPC and MCP. Non-browser clients may omit Origin. |
| [lib/sanitize.ts](server/src/lib/sanitize.ts) | Checked HTML normalization, tag and URL filtering, and removal of remote image and CSS references. |
| [lib/schemas.ts](server/src/lib/schemas.ts) | Sign-in input is strict and excludes client-selected mail hosts. Preference updates validate the fields being changed. |
| [lib/session-cookies.ts](server/src/lib/session-cookies.ts) | Active and account-list cookies are signed. The script-readable ID selects UI state. Switching requires membership in the signed list. |
| [lib/session.ts](server/src/lib/session.ts) | Hosted session reads now check the pinned IMAP authority. Rejected credentials invalidate the corresponding stored session. An outage preserves it. This adds an IMAP authentication round trip per hosted session resolution. |
| [lib/shortcuts.ts](server/src/lib/shortcuts.ts) | Shortcut identifiers and defaults originate in a static catalog. |
| [lib/sieve.ts](server/src/lib/sieve.ts) | Reviewed quoting, bounded response parsing, required STARTTLS and authentication order. |
| [lib/signature.ts](server/src/lib/signature.ts) | Signature HTML is sanitized before it is stored or composed into mail. |
| [lib/smtp.ts](server/src/lib/smtp.ts) | SMTP requires encrypted transport. Attachment delivery disables URL and local-file access in the mail composer. |
| [lib/timezones.ts](server/src/lib/timezones.ts) | Time-zone options come from the runtime or a static fallback. |
| [mail/assistant-connection-store.ts](server/src/mail/assistant-connection-store.ts) | Connection lookup uses the server-derived mailbox identity. |
| [mail/assistant-connections.ts](server/src/mail/assistant-connections.ts) | Reviewed provider setup, mailbox-keyed state, cancellation and cleanup of saved provider credentials. |
| [mail/assistant-containers.ts](server/src/mail/assistant-containers.ts) | Reviewed container ownership labels, private port bindings, resource limits and dropped capabilities. Runtime socket access is an operator privilege. |
| [mail/assistant-hosting.ts](server/src/mail/assistant-hosting.ts) | Shared placement denies assistant setup. Dedicated placement checks that the mailbox uses the configured authority. |
| [mail/assistant-sources.ts](server/src/mail/assistant-sources.ts) | Source collections are keyed by the per-turn grant, bounded and explicitly closed. |
| [mail/assistant-targets.ts](server/src/mail/assistant-targets.ts) | Cloud assistant runtime selection depends on placement. Remote targets are a standalone feature. |
| [mail/assistant.ts](server/src/mail/assistant.ts) | Reviewed mailbox-keyed history, request ownership, consent, cancellation, and grant cleanup on completion or disconnect. |
| [mail/drafts.ts](server/src/mail/drafts.ts) | Draft reads and writes use authenticated IMAP. Composing checks the sender, and draft replacement appends before deleting the previous copy. |
| [mail/grants.ts](server/src/mail/grants.ts) | Checks token hash, ownership, scope, expiry, revocation and parent grant. Stored credentials are bound to the grant and mailbox. |
| [mail/identity.ts](server/src/mail/identity.ts) | Identity includes installation, email and backend endpoints. These values repeat if an address is recreated on the same host. |
| [mail/mcp.ts](server/src/mail/mcp.ts) | Rechecks grant and scope around tool use, limits requests per mailbox, and creates a proposal for sends requiring approval. |
| [mail/messages.ts](server/src/mail/messages.ts) | Validates sender identity and reads originals from the authenticated mailbox when preparing a reply or forward. |
| [mail/outbox.ts](server/src/mail/outbox.ts) | Traced owner-derived idempotency, encrypted payloads, revision checks, job claiming and ambiguous submission outcomes. |
| [mail/runtime/Dockerfile](server/src/mail/runtime/Dockerfile) | Reviewed the pinned assistant runtime base and build-time OS dependency. Runtime access depends on the dedicated hosting gate. |
| [mail/sending-settings.ts](server/src/mail/sending-settings.ts) | Sending secrets are encrypted with the domain and issuing authority. Hosting placement is persisted transactionally. |
| [routes/auth.ts](server/src/routes/auth.ts) | Sign-in checks IMAP. Account changes use signed session membership. Browser session mutations now reject unrelated origins before processing. |
| [routes/branding-admin.ts](server/src/routes/branding-admin.ts) | Instance-level writes require the operator token and validated fields. |
| [routes/idle.ts](server/src/routes/idle.ts) | Opening the event stream requires a valid session and uses its IMAP credentials. |
| [routes/sending-admin.ts](server/src/routes/sending-admin.ts) | Requires the private sending administrator token. Validates hosting bindings and API origin, and omits the secret from reads. |
| [trpc/index.ts](server/src/trpc/index.ts) | Checked router registration against the public, session, and assistant-specific authorization paths. |
| [trpc/trpc.ts](server/src/trpc/trpc.ts) | Protected procedures require session and mail credentials. Browser mutations check origin. |
| [trpc/routes/assistant.ts](server/src/trpc/routes/assistant.ts) | Assistant setup and actions use a placement gate. Mailbox-selected operations check the supplied ID against the session. |
| [trpc/routes/blocked-senders.ts](server/src/trpc/routes/blocked-senders.ts) | User input is a validated sender address. The session supplies the target mailbox. |
| [trpc/routes/branding.ts](server/src/trpc/routes/branding.ts) | Public information includes instance branding and the Cloud account link when enabled. |
| [trpc/routes/cookies.ts](server/src/trpc/routes/cookies.ts) | Consent reads and writes use the session email. The public locale procedure carries no mailbox authority. |
| [trpc/routes/drafts.ts](server/src/trpc/routes/drafts.ts) | Each handler passes the authenticated session to the draft operations. |
| [trpc/routes/labels.ts](server/src/trpc/routes/labels.ts) | Reads user flags from the authenticated INBOX. Some mutation responses are compatibility behavior without persisted label definitions. |
| [trpc/routes/mail-agents.ts](server/src/trpc/routes/mail-agents.ts) | Grant creation and job details, approval, rescheduling and cancellation all receive the current mailbox identity. |
| [trpc/routes/mail.ts](server/src/trpc/routes/mail.ts) | Traced inbox, Sent, attachment reads, sending, cancellation and remote-content controls. Recipient autocomplete currently returns an empty result. |
| [trpc/routes/settings.ts](server/src/trpc/routes/settings.ts) | Settings writes merge validated fields inside a transaction keyed to the session email. |
| [trpc/routes/shortcut.ts](server/src/trpc/routes/shortcut.ts) | User overrides use the email and shortcut ID. Reset applies to the signed-in user. |
| [trpc/routes/stubs.ts](server/src/trpc/routes/stubs.ts) | Reviewed compatibility routes and account switching. Switching consults the signed account list. |
| [trpc/routes/templates.ts](server/src/trpc/routes/templates.ts) | Listing and deletion are scoped to the session email. Address reuse needs the lifecycle fix above. |
| [trpc/routes/user.ts](server/src/trpc/routes/user.ts) | Webmail account deletion clears a session and selected preferences. It is separate from deleting the Dovecot mailbox or retiring its jobs and grants. |

## Verification scope

### Container runtime inventory

| Files under `apps/email/docker` | Review notes |
| --- | --- |
| [entrypoint.sh](docker/entrypoint.sh), [build-config](docker/build-config), [supervisord.conf](docker/supervisord.conf) | Traced first boot, operator-provided secrets, daemon startup order and the persistent configuration mounts. These processes and their host form a shared trust boundary. |
| [db-bootstrap.sh](docker/db-bootstrap.sh), [reconcile-db-port.py](docker/reconcile-db-port.py), [configure-fail2ban-db.py](docker/configure-fail2ban-db.py) | Checked database setup, credential substitution and runtime permissions. Bootstrap now uses a private temporary directory, removes the staged SQL on exit and reads the internal role password from the environment in psql. The five native service roles still share a password. The existing-schema shortcut checks for the mailbox table, so a restart alone cannot establish that an interrupted first boot completed. |
| [api-relay-config.py](docker/api-relay-config.py), [api-relay.py](docker/api-relay.py), [sender_aliases.py](docker/sender_aliases.py) | Traced authenticated sender identity through the Postfix maps, envelope checks and domain-specific relay configuration. Checked how unsupported formats and upstream failures are handled. |
| [prepare-dovecot-runtime.sh](docker/prepare-dovecot-runtime.sh), [verify-dovecot-security.sh](docker/verify-dovecot-security.sh), [reconcile-ssl.sh](docker/reconcile-ssl.sh) | Reviewed Dovecot runtime permissions, effective TLS and authentication checks, and installation of operator-provided certificates. |
| [postfix-chroot-etc.sh](docker/postfix-chroot-etc.sh), [postfix-filter-tls.sh](docker/postfix-filter-tls.sh), [prepare-amavis-runtime.sh](docker/prepare-amavis-runtime.sh) | Checked Postfix chroot dependencies, the content-filter hop and Amavis runtime directory ownership. |
| [prepare-mail-logs.sh](docker/prepare-mail-logs.sh), [rsyslog-rotate](docker/rsyslog-rotate), [logrotate-clamav-freshclam](docker/logrotate-clamav-freshclam) | Checked log directory ownership, rotation and daemon reopen behavior. Retention and operator access also depend on deployed volume settings. |

### Test coverage

The worker HTTP tests now load the shipping iRedMail schema and exercise two workspaces, including DNS ownership, domain creation, mailbox creation, password changes, deletion, aliases, counts, and revoked credentials. Separate Docker tests exercise real PostgreSQL, Postfix and Dovecot on an isolated network. Their outbound recipient is a fixture. The PostgreSQL restore check uses a fresh cluster. Browser auth tests substitute the IMAP probe to exercise explicit credential denial and a temporary outage.

| Check | Result |
| --- | --- |
| API mail and managed-mail suites | 603 passed across 64 files |
| Webmail server with the repository-pinned Bun 1.4.4 | 267 passed across 23 files |
| Managed-mail repository tests | 2 passed |
| Docker mail authentication, tenant isolation, relay and restore | 7 passed |
| Docker PostgreSQL bootstrap | 7 passed |
| TypeScript checks | API and webmail server both passed |

One SMTP policy check timed out during a concurrent run and passed on the isolated rerun. A separate run with the machine's older Bun 1.3.1 crashed during the assistant suite. The webmail result above uses the repository's declared runtime.

New authenticated webmail requests recheck the hosted mailbox credential. A previously established IMAP connection can outlive a password change. No sustained load measurement was taken for the extra authentication round trip.

The stored Maildir path for newly created addresses includes a timestamp with one-second precision. Rapid deletion and recreation can select the same physical path while cleanup from the old account is outstanding. The mailbox lifecycle release criterion includes this case as well as the SQLite data.

Public delivery, production ingress, deployed image versions, and a complete fleet restore require deployment evidence. The source review and functional checks apply to this checkout.
