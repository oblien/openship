# Support intake and sender blocking

Customer support starts at `app.openship.io/support` with a real account session.
The website's `/support` page directs customers there. Existing email replies are
preserved. The public `/contact` form supports general inquiries and account-access
problems and delivers to a separate inbox. Its browser request goes directly to
Cloud so the trusted transport IP remains available for quotas and blocks.

## Deployment configuration

Provision `contact@openship.io` (or another receiving mailbox), then configure:

- Cloud API: `CONTACT_EMAIL`, `CONTACT_TURNSTILE_SECRET`, and
  `CONTACT_TURNSTILE_HOSTNAMES` (comma-separated; defaults to openship.io and www.openship.io).
- Website: `CONTACT_TURNSTILE_SITE_KEY` for the same Cloudflare widget. It is read
  at request time, so a new frontend build is unnecessary for key rotation.

Use a production Turnstile widget restricted to the website's hostnames. The
public API verifies the token, action (`contact`), and hostname through Siteverify.
Missing configuration or provider failures reject the submission. No bypass is
available through the old `/api/contact` proxy. Customer dashboard support does
not depend on the public widget.

The schema upgrade adds the trusted submission IP and an operator-owned block
list. Existing tickets remain intact. New tickets and customer replies enforce
both identity quotas and a shared IP quota across replicas.

## Operator blocks

Only the Cloud instance's internal operator token can access `/api/cloud/support/blocks`.
Customer sessions, account owners, PATs and organization grants cannot manage these rules.
Use the `X-Internal-Token` header from your secure operator environment.

- `GET /blocks` lists rules.
- `POST /blocks` with `{"kind":"email","value":"sender@example.com","reason":"Unwanted submissions"}` blocks an exact normalized address.
- `POST /blocks` with `{"kind":"ip","value":"192.0.2.1","reason":"Verified intake abuse"}` blocks an exact IP.
- `DELETE /blocks` with the same kind/value removes a block.

IP values are canonicalized, including IPv4-mapped IPv6. The caller cannot supply
or override a ticket's transport IP in the payload. Customer ticket responses omit
IPs and block rules. Queued email for blocked submissions is suppressed; already
sent messages cannot be recalled. Email addresses in anonymous forms are claims,
not verified identities. Correlate a ticket timestamp with trusted access logs
before blocking an IP. These intake rules do not change SMTP delivery rules.

## Webmail sender filters

Use the message menu's **Block sender**, or **Settings → Privacy → Blocked senders**.
Future messages from that exact From address go directly to Spam at delivery time.
Unblocking is available in Privacy settings. This uses the mailbox's own
ManageSieve credentials over verified STARTTLS, independently of browser activity.
Existing personal filters are included unchanged and restored when the last sender
is unblocked. Other mailboxes cannot be selected by a client request.

The webmail server defaults to the signed-in account's IMAP host on port 4190.
Operators can set `DEFAULT_SIEVE_HOST` and `DEFAULT_SIEVE_PORT` for an internal
mail-service address. The TLS certificate must match that configured host. Expose
ManageSieve only to the webmail server when a public listener is unnecessary.
A server lacking secure ManageSieve displays an explicit unavailable state;
there is no successful-looking browser-only fallback.

Support notifications come from the application's configured sender. Blocking that
sender in webmail would hide all notifications, so unwanted form submissions must
be blocked at intake using their submitted email and verified request IP instead.
