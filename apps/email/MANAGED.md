# Openship managed mail

Openship Mail owns inbound SMTP, Dovecot IMAP, mailbox data and webmail. The Emails dashboard calls the same domains, mailboxes, aliases, DNS and statistics routes for all inbox placements. The control plane authorizes the requested service and resolves it to the instance, the shared worker under the organization’s namespace, or its dedicated VM. A connected instance can open the same Cloud dashboard. API sending uses the organization’s Oblien namespace independently of inbox placement. DNS automation uses the customer's connected DNS provider in either mode.

## Run locally

| Flow | Command from the repo root | Open |
| --- | --- | --- |
| Self-hosted dashboard | `bun dev` | `http://localhost:3001/emails` |
| Cloud dashboard | `bun run dev:local-saas` | `http://localhost:3002/emails` |
| Two real local sample inboxes | `bun run dev:email:sample` | `http://127.0.0.1:3040` |

Mail checkout follows the Cloud API’s shared `BILLING_ENABLED` setting and requires service offers in Oblien’s reseller catalog.

Use the repository's pinned Bun version. The sample runs with Docker and has seeded inboxes and an automated delivery check. See [the sample guide](dev/README.md).

The standalone GreenMail sample has its own inboxes. For mailbox writes from the Cloud dashboard, register a writable OpenShip Mail worker using the capacity configuration below. **Mailboxes → Manage → Change password** updates the account Dovecot authenticates on the selected worker. **Delete** opens the confirmation for that same account.

To exercise Cloud activation without reserving a worker or spending provider credits, run the authenticated route tests from the repository root.

```sh
bun run --cwd apps/api test test/modules/managed-mail
```

They use a migrated in-memory database and fixtures for the worker, DNS resolver and provider. They cover concurrent activation, organization isolation, ownership proof, quota checks, private key installation and checkout recovery.

### Test a customer workspace against live Oblien

1. Sign in to the local Cloud dashboard and open [Emails → Sending](http://localhost:3002/emails?mailView=sending). Use a test workspace with an active email allowance and a subdomain you control. Add the sender domain, publish the records shown, and verify until its status is ready.
2. Create an API key for that domain. Submit one plain-text message to OpenShip’s `POST /api/mail/send` with the send-only bearer key shown in the dashboard. Cloud resolves its workspace and verified domain from the PAT grant. Use a mailbox you control or the [AWS SES delivery simulator](https://docs.aws.amazon.com/ses/latest/dg/send-an-email-from-console.html). Save the receipt ID and idempotency key. A replay with the same payload and key should return the same ID.
3. Check that receipt with `mail.messages.get(namespace, id)` using the Cloud management credential on the server. Wait for `delivered` and refresh Sending. A one-recipient submission should add one accepted recipient to the sender and domain totals reported by `mail.senders.listUsage` and `mail.domains.listUsage`. In Sending, set a cap of zero on the disposable domain and retry with a **new** idempotency key. Expect `mail_quota_exhausted` and no additional accepted recipient. Clear the temporary cap and revoke the test key.
4. To test hosted inboxes, attach a writable worker, activate shared mailboxes, verify the inbound domain and publish its MX. Create a disposable mailbox in the dashboard and enable managed sending for its domain. Deliver a message from a controlled external mailbox, open it in webmail, and check the Overview inbox count. Send a new plain-text message back and check its arrival and the sender's usage. Change the mailbox password and verify that a fresh IMAP connection requires the new password. Delete the disposable mailbox and verify that a fresh login fails.

### Run mail in the OpenShip Compose stack

On a Linux Compose host, OpenShip Cloud and self-hosted OpenShip can run the same `openship-mail` image alongside the control plane. The Emails installer prepares the mail engine, its private Postgres database, mailbox storage, queue and DKIM keys. Webmail is the linked HTTPS app for that engine.

1. Get the running control plane’s Compose project name from `docker compose ls`. Set `OPENSHIP_MAIL_COMPOSE_PROJECT` to that name in the **self-hosted worker API’s environment** before installing mail on this host. Restart that API to pick up the setting.
2. Register the Linux host on the worker and run **Emails → Set up mail** for its primary domain. For Cloud shared hosting, the fleet’s `prepare: true` path can run that same installation. Complete the DNS and certificate steps and link webmail. The installer starts the `mail` and `db` services in the named project and writes their manifest to `/var/lib/openship/mail/compose.yaml`.
3. For the source/Cloud stack set `COMPOSE_FILE=docker-compose.yml:docker-compose.mail.yml` in the root `.env` and keep the same Compose project name. For the pull-based stack use `COMPOSE_FILE=docker/docker-compose.yml:docker-compose.mail.yml` from the repo root with `--env-file .env`. Run `docker compose config --quiet` and `docker compose ps mail db`. Subsequent stack updates read the installer’s image, volumes and credentials. Set `OPENSHIP_MAIL_MANIFEST` if the Compose client reads the generated file through another filesystem path.

Existing standalone mail installations continue to use their original project. Changing a project name in the environment does not migrate an existing database or mailboxes.

### Publish the shared webmail sign-in

Use a separate installation domain for the shared engine so the operator can host its own corporate mailboxes on a dedicated service. For example, installing the shared engine for `shared.example.net` gives it the technical hostname `mail.shared.example.net`. Point that hostname at the mail VM and use it as the MX target for customer domains assigned to this worker. The VM accepts inbound SMTP on port 25 and mailbox logins over TLS on port 993.

In the worker’s Emails dashboard, open **Deploy webmail** for that engine. Give the linked Webmail app the public hostname, for example `mail.example.net`, and route HTTPS for that name to the app. In the SaaS API’s `OPENSHIP_MAIL_ENGINES` entry, use `mail.shared.example.net` for `hostname` and `https://mail.example.net` for `webmailUrl`. The worker verifies the linked app’s origin and IMAP host before accepting a shared assignment.

Each fleet entry has its own webmail origin. The shared sign-in opens the inboxes on that engine. Users on a dedicated VM reach their installation through **Open webmail** in the Cloud dashboard. The operator can assign its corporate domain’s MX to its dedicated VM independently of the public sign-in hostname.

### Mail Desktop

A mailbox user opens **OpenShip Mail**, chooses **OpenShip Cloud**, and enters their email address. Desktop sends the domain to `GET /api/mail/discovery`. Cloud matches the ownership TXT or primary MX to a provisioned service, then asks its assigned worker whether it hosts that domain. The response contains the webmail origin. The mailbox password goes directly to webmail over HTTPS. The same inbox, managed sending relay, and dedicated assistant settings serve browser and desktop clients.

For a self-hosted mailbox, choose **Self-hosted** and enter the HTTPS address of the webmail installation. An internal hostname works when the device can resolve and reach it, including over a VPN. Each saved mailbox has its own browser session and cache. Use **Mailboxes → Switch or add mailbox** to switch, add, or remove a mailbox from the device.

Run `bun run dev:mail-desktop` from the repository root. To use local SaaS discovery, prefix the command with `OPENSHIP_CLOUD_API_URL=http://127.0.0.1:4100`. Development also accepts loopback HTTP webmail URLs. With the [sample mail environment](dev/README.md) running, `OPENSHIP_MAIL_SAMPLE_URL=http://127.0.0.1:3040 bun run --cwd apps/mail-desktop test:e2e` checks mailbox sign-in and inbox access in Electron. Run `bun run build:mail-desktop` on the target OS to make the desktop ZIP in `apps/mail-desktop/out/make`.

### IPv4 access for dedicated webmail

Deploy the [webmail ingress](webmail-ingress/compose.yaml) on an OpenShip-operated Linux host with a public IPv4 address, outbound IPv6, and ports 80 and 443 available. Set `FLEET_DOMAIN` to the operator-owned DNS zone in `OPENSHIP_MAIL_DEDICATED_FLEET`. The gateway resolves dedicated VM addresses with an IPv4-reachable DNS resolver. Set `DNS_RESOLVER` to use your own resolver. Start the gateway from the repository root.

```sh
FLEET_DOMAIN=mailfleet.example.net docker compose -f apps/email/webmail-ingress/compose.yaml up -d
```

Once the gateway is reachable, add its public IPv4 address as `webmailIngressIPv4` in the fleet configuration. New dedicated subscriptions receive a webmail A record pointing to the gateway and an AAAA record pointing to the VM. For each already-enrolled VM, add the A record to its existing `webmail.<service-id>.<fleet-zone>` hostname. Shared installations supply their own reachable `webmailUrl`.

The gateway forwards TLS by server name to the VM's IPv6 address. Webmail presents its own certificate and authenticates the mailbox there. Port 80 forwards certificate challenges and redirects ordinary requests to HTTPS. The mail hostname and customer MX continue to route SMTP and IMAP independently of the webmail gateway.

### Cloud capacity

Configure the Cloud API in `apps/api/.env.local-saas` for local testing or in the deployment environment. The API applies its database migration during startup. The following is one entry in `OPENSHIP_MAIL_ENGINES`.

```json
[{
  "origin": "https://worker.example.net",
  "serverId": "registered-server-id",
  "token": "worker-organization-pat",
  "hostname": "mail.slot01.example.net",
  "webmailUrl": "https://mail.slot01.example.net",
  "placement": "standard",
  "shared": true,
  "prepare": true
}]
```

The origin is an Openship self-hosted **API** running this revision. The token belongs to the worker organization that owns the registered Linux target and can manage its mail server and webmail project. Keep it server-side. For local development a loopback HTTP API origin is supported.

For a disposable development target, build the updated webmail image on its Docker runtime from the repo root. The normal catalog deploy reuses the local image.

```sh
docker build -f apps/email/Dockerfile.webmail -t ghcr.io/oblien/openship-webmail:latest .
```

### Shared and dedicated placement

A shared host runs one OpenShip Mail Compose project, its Postgres database and a linked webmail deployment. The worker persists domain ownership in the mail database and scopes domains, mailbox operations, aliases, DNS and statistics to that owner. A removed domain stays reserved until its mailbox data has been cleaned up. Mailbox preferences belong to the authenticated mailbox. Each verified domain has its own sending credential. Shared aliases can deliver to another domain owned by the same organization. External automatic forwarding currently requires a private installation.

For a shared fleet upgrade, apply worker database migration 0240 and deploy the worker and Cloud APIs together. Cloud uses the operator PAT to enroll each existing or new service. The worker binds a separate bearer credential to its local server, organization namespace and Cloud service ID. It checks the operator PAT’s current grants, expiration and revocation on customer requests. Rotating the operator PAT re-enrolls the same service. For the first upgrade, allow IMAP clients to reconnect once when the worker activates the private-inbox policy. This disables IMAP folder sharing across the shared host while preserving ordinary private folders.

Use `"placement": "standard", "shared": true` for the shared fleet. Existing entries without the shared flag retain their exclusive assignment. Each host needs persistent storage, backups and a routable address for inbound SMTP and IMAP. Identify a physical worker by its API origin, registered server ID and technical hostname. Retire and wipe an old host before reusing it.

When upgrading webmail from unsigned session cookies, update all webmail replicas for the host together. Users sign in once per mailbox to receive signed cookies. Keep the installation's existing `SESSION_ENCRYPTION_KEY` across replicas and restarts.

Dedicated mail is a separate monthly capacity subscription. In **Billing → Email plans → Dedicated mail server**, choose mailbox storage and a sending tier, then review the single monthly charge. Payment confirmation provisions a new permanent VM in its own Oblien namespace. Existing shared inboxes and Cloud VMs keep their assignments. The Emails service picker opens each installation in the regular mail admin panel.

Mindwire is optional on dedicated mail. Configure the assistant-only runtime engine on the dedicated VM, then each mailbox owner can connect a provider in webmail. For an existing dedicated installation, update Cloud and the worker, redeploy the linked webmail on the same VM through `/api/mail/webmail/deploy-project` with `dedicatedAssistant: true`, then repeat `PUT /api/mail/admin/:serverId/webmail/hosting` with the existing service namespace, pinned IMAP hostname as `imapHost`, and `dedicated: true`. This preserves the current catalog installation's mailbox data and sending keys. [Mail assistant deployment setup](MAIL-AGENTS.md#deployment-setup-once-per-mail-installation)

For automatic enrollment, set `OPENSHIP_MAIL_DEDICATED_FLEET` on the SaaS API. It accepts a JSON object with the following fields.

| Field | Value |
| --- | --- |
| `origin`, `token` | HTTPS origin of the OpenShip self-hosted worker and a private operator-organization token permitted to register servers and manage mail and webmail |
| `sshPublicKey` | Ed25519 public key for the SSH agent on that worker, which reaches new VMs through the Oblien SSH bastion |
| `domain` | Operator-controlled DNS suffix for dedicated servers |
| `dnsProvider`, `dnsToken`, `zoneId` | Cloudflare or DigitalOcean provider name (`cloudflare` or `digitalocean`), zone-scoped DNS token and authoritative zone ID |

Run `bun run --cwd apps/api cloud:check --dedicated-mail-fleet` with the deployed SaaS environment to check billing, the configured fleet, worker inventory access and DNS zone read access. To review the local configuration, run `bun --env-file=.env.local-saas scripts/cloud-readiness.ts --dedicated-mail-fleet` from `apps/api`. These checks are read-only. A live purchase on a pilot domain exercises VM creation, DNS writes, certificate issuance and inbox delivery.

The fleet uses the immutable VM returned for the paid order. It enables inbound IPv6 for SMTP, submission, IMAP and web traffic, publishes the technical hostnames and MX, registers the target with the worker and runs the existing Compose mail installer. The installer publishes DKIM through the fleet, checks DNS and certificates, and deploys webmail before opening administration. This automatic network path requires an IPv6-capable provider node and clients. For IPv4 reachability, provision inbound IPv4 routing for the technical hostname. Oblien handles outbound delivery through the managed relay.

For an operator-routed installation, supply a dedicated `OPENSHIP_MAIL_ENGINES` entry whose `providerVmId` matches the purchased VM's immutable Oblien ID. Supply the routed mail hostname, worker origin, worker server ID, token and webmail URL. Existing private installations registered by `cloudServerId` continue to use their original worker. Previously reserved hosts can still activate under their operator grant.

For an entitlement-only local test, set a time-limited grant with your test organization's ID and a future UTC expiry. The optional dedicated flag permits a reserved VM. To simulate an API-only subscription, set `"sendingOnly": true`. This grants the tier’s outbound allowance. Any mailbox allowance still comes from a separate paid compute or hosted entitlement.

```dotenv
OPENSHIP_MAIL_PLAN_GRANTS='{"your-org-id":{"plan":"team","until":"2027-01-01T00:00:00Z","dedicated":true}}'
```

Open Emails, activate mail, add a domain, publish its ownership TXT, then publish the returned MX records and create a mailbox. The overview gives the webmail URL and mail client hostname. IMAP uses port 993 with TLS and native submission uses port 587 with STARTTLS. A billing lookup failure leaves the existing inbox accessible.

### Sending

From a self-hosted dashboard or Desktop, open **Emails → your mail server → Sending → Connect to OpenShip Cloud**. An existing Cloud connection opens the linked workspace directly. If it needs a sending allowance, **View email plans** opens the regular Cloud pricing flow. Select a sender domain hosted on this server, publish its requested DNS records and verify it. Older webmail deployments may need a redeploy to receive their configuration token.

- **Enable API relay** connects authenticated submissions from desktop and mobile mail clients. Clients submit to their usual OpenShip Mail host on port 587 or 465. Postfix sends supported messages to the linked Cloud API over HTTPS using a domain-scoped OpenShip key. This works on the OpenShip Mail container with or without webmail. **Disable API relay** revokes the key and removes that domain’s route. Self-hosted operators can also configure an independent SMTP provider in **SMTP delivery settings**.
- **Enable webmail sending** connects the linked webmail deployment. It proves the mailbox login against the installation’s IMAP host and submits through the same OpenShip API. Webmail uses its outbox message ID for retries and saves the Sent copy.

On shared and dedicated Cloud installations, enabling managed sending for a verified mailbox domain connects both transports. Deploy the updated Cloud API, worker, mail engine image and webmail together. Enable sending on each existing domain to migrate it.

Cloud authenticates the OpenShip key, checks its domain grant and verification, and submits through the Oblien SDK under the key owner’s organization namespace. Postfix selects the route by the authenticated mailbox and checks both the envelope sender and the From header. Each Cloud tenant’s relay runs under a separate Unix identity with access to its own credentials. Reserve UIDs and GIDs 50000–59999 for those identities on the mail engine’s bind mounts. A transient Cloud error leaves the message in the Postfix queue for a retry with the same idempotency key. Inbound MX on port 25 continues to deliver to Dovecot. On authenticated submission ports the managed API transport takes the place of the originating Postfix content filter for enrolled domains. The host administrator, Postfix configuration and Cloud control plane remain trusted infrastructure.

The current provider API accepts structured text and HTML, including multipart alternatives, To, Cc, Bcc and Reply-To. Attachments, calendar invitations, signed content and threading headers require full MIME delivery. The managed relay reports unsupported messages. Self-hosted installations can use an independent SMTP transport for full MIME.

### Plans and billing

Read the current offers from the public `GET /api/billing/plans` response under `data.mail`. It includes hosted and API sending prices in cents, domain and mailbox allowances, and dedicated storage options. The website and dashboard consume the same catalog.

The included allowance is per organization. A standalone subscription supplies the selected allowance. Hosted mailbox quotas reserve capacity from the organization's storage total. Self-hosted inbox capacity belongs to the operator. API keys, managed webmail sends and managed relay submissions use one organization allowance, counted across To, Cc and Bcc. Self-hosted sending through an independent relay uses that relay’s allowance.

The dashboard reads sender and domain usage from the organization's Oblien namespace. Billing admins can set or clear caps for individual addresses or domains. A zero cap blocks sending. Oblien enforces these caps across keys and transports in the UTC calendar month. Clearing a cap preserves usage. Older receipts without a sender stay in the workspace’s unattributed total and can affect sender caps on a known domain.

Dedicated storage is usable mailbox space. The VM receives an additional system allocation from the retail catalog. Mailbox count is limited by the storage pool, and the selected sending tier supplies the domain and recipient limits. Shared mail, webmail and application keys draw from the same organization sending allowance. Each funded dedicated subscription adds its allowance to that pool. Billing and mailbox storage remain separate for each service.

Cloud uses its existing Oblien management credentials to create a separate mail namespace per organization. The namespace owner's funded wallet pays for accepted recipients. Enable billing and reseller service offers for paid checkout. Sending uses revisioned calendar-month quotas, a rolling daily cap and a burst cap. The mail control plane reconciles allowances after billing events and every 15 minutes. Expiration stops managed sending and new hosted provisioning. Existing inbox data and the worker assignment are retained.

The plan catalog lives in `packages/core/src/pricing/pricing.json#mail`. Changing the price of a published plan requires a new offer version and verification of existing subscriptions under their original terms.
