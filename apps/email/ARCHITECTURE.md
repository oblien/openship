# Self-hosted email - target architecture

Status: **target state, not current.** Today only the engine (iRedMail) and Zero
(server + client) exist side-by-side. This document is the blueprint we're
moving toward.

---

## TL;DR

- **Three actors:** openship (admin UI + provisioning), iRedMail engine
  (Postfix + Dovecot + Amavis + iRedAPD + fail2ban - the actual mail server),
  and Zero (the user-facing webmail).
- **One Postgres host, four databases on it.** Of those four, **we own only one**
  (`vmail`). The other three (`amavisd`, `iredapd`, `fail2ban`) belong to their
  upstream subsystems - they own their own schemas, we never touch them.
- **`packages/db-email`** is the Drizzle home of `vmail` + `mail_app`. That's
  the only schema we manage. Postfix and Dovecot query it directly via the SQL
  maps iRedMail's installer already generates.
- **iRedMail's installer keeps ownership of daemon configuration.** We don't
  write a parallel config generator; we configure iRedMail to skip what we
  don't want (iRedAdmin, SOGo, Roundcube, MySQL, OpenLDAP) and to *reuse* the
  `vmail` DB we provisioned via `db-email` instead of creating one itself.
- **Zero is the only UI.** iRedAdmin / SOGo / Roundcube / iRedMail's nginx
  are deleted.
- **openship Postgres stays separate** - never linked via FK to the mail DBs.
  openship calls the email server's admin API over HTTP for any mail operation.

---

## Identities

There are three identity layers and they never collapse into one row.

| Layer | Lives in | Who | Used for |
|---|---|---|---|
| **openship admin** | openship DB `public.user` | Human who logs into the openship dashboard. **Super-admin only.** | Manages mail accounts via UI / API. |
| **mail account** | mail-server DB `vmail.mailbox` | Email user (`alice@acme.com`). Created BY an openship admin; never signs up themselves. | Authenticates to Postfix/Dovecot. Logs into Zero. |
| **mail-UI state** | mail-server DB `mail_app.user_settings` (and similar) | Same person as `vmail.mailbox`. | Hotkeys, signatures, AI summaries, etc. - Zero-only concerns. |

The openship admin does **not** appear in `vmail.mailbox`. Admins manage; they
don't receive mail through this system unless an admin creates a mailbox for
themselves separately.

---

## Database topology - one host, four DBs

```
openship Postgres ($DATABASE_URL)                 ← unrelated to mail
└── schema "public"
    • user (admins)
    • project, deployment, service, …


Mail-server Postgres (the email VPS, one instance)
├── database "vmail"        ($VMAIL_DATABASE_URL)     ← WE own this
│   ├── schema "vmail"        - accounts, domains, aliases, forwardings, …
│   └── schema "mail_app"     - Zero app state (settings, summaries, notes)
│
├── database "amavisd"      ($AMAVIS_DATABASE_URL)    ← amavisd owns, we install
│   • users, mailaddr, wblist, policy, msgs,
│     msgrcpt, quarantine, …  - schema defined upstream
│
├── database "iredapd"      ($IREDAPD_DATABASE_URL)   ← iRedAPD owns, we install
│   • throttle, greylisting, srs, … - schema defined upstream
│
└── database "fail2ban"     ($FAIL2BAN_DATABASE_URL)  ← fail2ban owns, we install
    • jails, banned - schema defined upstream
```

**Why split this way?**

The `vmail` schema is OUR product surface - it carries the mailbox accounts
that openship admins create and that Zero authenticates against. Owning it in
Drizzle gives us type safety, migrations on our terms, and the freedom to add
columns (e.g., `created_by_openship_user_id` for auditing) without fighting
upstream.

The other three DBs belong to their upstream projects. Their schemas evolve
with their releases (amavisd alone has 10+ tables that change shape across
major versions). Absorbing them into our Drizzle schema would commit us to
tracking those changes forever, for zero benefit - we don't need to read
amavisd's `msgs` table from application code; amavisd does. Let the daemons
own their data.

If we ever need to surface, e.g., spam quarantine in the openship dashboard,
we open a separate read-only connection from openship's mail controller to
`$AMAVIS_DATABASE_URL` and query directly. Schema ownership stays clean.

---

## How the actors connect

```
┌─ openship dashboard (admin UI page)
│   "create mailbox alice@acme.com"
└─ openship API handles it locally - writes vmail.mailbox via @repo/db-email.
   NO outbound HTTPS call to the mail VPS. No public admin endpoint.
                                │
                                ▼
┌───────────────────────────────────────────────────────────────────┐
│  Email server (one Linux VPS)                                     │
│                                                                   │
│  ┌─ Zero server (Node)                                            │
│  │   • User API only - existing Zero tRPC, rewired to IMAP driver │
│  │   • Authenticates against vmail.mailbox.password via Dovecot   │
│  │   • Reads/writes mail_app.* (UI state); reads vmail.mailbox    │
│  │     for user identity                                          │
│  │                                                                │
│  │   Drizzle (@repo/db-email)                                     │
│  │           │                                                    │
│  │           ▼                                                    │
│  ├─ Postgres host (4 DBs)                                         │
│  │     vmail    ◀── openship API (admin writes),                  │
│  │                  Zero server (user reads),                     │
│  │                  Postfix + Dovecot (daemon reads)              │
│  │     amavisd  ◀── amavisd (engine)                              │
│  │     iredapd  ◀── iredapd (engine)                              │
│  │     fail2ban ◀── fail2ban (engine)                             │
│  │                                                                │
│  ├─ Zero client (Workers or Node)                                 │
│  │      speaks IMAP   ▶ Dovecot :993                              │
│  │      speaks SMTP   ▶ Postfix :587                              │
│  │                                                                │
│  └─ Mail daemons (Postfix, Dovecot, Amavis, ClamAV, SpamAssassin, │
│     iRedAPD, fail2ban) - configured by iRedMail's installer       │
└───────────────────────────────────────────────────────────────────┘
                                ▲
                                │
                  openship routing layer (front)
                  • mail.example.com         → Zero client
                  • api.mail.example.com     → Zero server (user API only)
                  • autodiscover.example.com → openship controller
                  • smtp/imap/pop3 raw TCP   → directly to VPS, no proxy
                  (no email-admin subdomain - admin is openship-internal)
```

The two halves of the system (openship side, email side) **never link via FK.**

**Admin operations are openship-internal.** openship's API has its own Drizzle
connection to the mail-server Postgres (via `@repo/db-email`) and writes
`vmail.*` rows directly when an admin creates a mailbox / domain / alias.
There is no public admin endpoint on the mail VPS - no `email-admin.<domain>`
subdomain, no admin tRPC routes on the Zero server, no shared-secret bearer
token. Postfix and Dovecot pick up new rows on their next query, same way
they would if iRedAdmin had written them.

**User operations stay on the mail VPS.** When a user opens their Zero
inbox, they hit `api.mail.<domain>` (Zero server) for app-state operations
and Dovecot:993 directly for IMAP. That's the only public surface on the
mail VPS.

---

## Schema ownership - who manages what

| Component | DB | Schema source-of-truth | Who applies migrations |
|---|---|---|---|
| `vmail.*` tables | `vmail` | `packages/db-email/src/schema/vmail.ts` | `db-email` Drizzle migrations |
| `mail_app.*` tables | `vmail` | `packages/db-email/src/schema/mail_app.ts` | `db-email` Drizzle migrations |
| Amavisd tables | `amavisd` | `engine/samples/amavisd/amavisd.pgsql` | iRedMail installer (unchanged) |
| iRedAPD tables | `iredapd` | iRedAPD's own schema (shipped by iRedAPD) | iRedMail installer (unchanged) |
| fail2ban tables | `fail2ban` | `engine/samples/fail2ban/sql/fail2ban.pgsql` | iRedMail installer (unchanged) |

iRedMail's installer normally creates the `vmail` DB and loads
`engine/samples/iredmail/iredmail.pgsql` into it. In our setup **we provision
`vmail` ourselves** via `db-email`'s migration, then point the installer at it.
That way our Drizzle schema is the single source of truth - even if it
differs slightly from iRedMail's upstream pgsql file (e.g., we add columns),
Postfix/Dovecot still get a working schema because Drizzle's generated DDL
covers everything the SQL maps need.

---

## Where config generation lives

**iRedMail's installer owns it.** We do NOT write a parallel TS config
generator.

The installer (`engine/iRedMail.sh` + helpers under `engine/functions/`)
takes env vars (`VMAIL_DB_NAME`, `VMAIL_DB_HOST`, `VMAIL_DB_BIND_USER`,
`VMAIL_DB_BIND_PASSWD`, etc.) and substitutes them into the template
`.cf` and `.conf` files under `engine/samples/postfix/pgsql/`,
`engine/samples/dovecot/dovecot-sql.conf`, etc. Output lands in
`/etc/postfix/pgsql/` and `/etc/dovecot/`. That mechanism is fine - it's
been working in iRedMail for over a decade.

What we change is:

1. **Skip steps we don't want.** iRedAdmin / SOGo / Roundcube / nginx /
   MySQL backend / OpenLDAP backend installation is gated by env vars
   in `engine/conf/global`. We set those to `NO` and the installer
   doesn't touch them.
2. **Use our `vmail` DB instead of creating one.** Add a "vmail DB
   already exists" branch in `engine/functions/postgresql.sh` (or
   equivalent) so the installer skips its CREATE DATABASE step for vmail
   and just configures Postfix/Dovecot/etc. against the existing one.
3. **Trim the installer.** Delete the files under `engine/` that we
   never use (the SOGo / iRedAdmin / Roundcube / nginx / MySQL /
   OpenLDAP function and sample directories).

That's it. No new TS generator. iRedMail keeps doing what it does well.

---

## What gets removed

### From iRedMail engine (`apps/email/engine/`)

| Removed | Why |
|---|---|
| `conf/iredadmin/`, `functions/iredadmin.sh`, samples for iRedAdmin | Openship dashboard replaces this. |
| `conf/sogo/`, `functions/sogo.sh`, `samples/sogo/` | Zero is the UI; we don't need groupware. |
| `conf/roundcube/`, `functions/roundcubemail.sh`, `samples/roundcubemail/` | Zero is the UI. |
| `conf/nginx/`, `functions/nginx.sh`, `samples/nginx/` | openship's routing layer handles web. |
| `conf/php/`, `functions/php.sh` | PHP runtime was only for the dropped web stack. |
| `conf/openldap/`, `functions/openldap.sh`, `functions/ldap_server.sh`, `samples/openldap/` | Postgres-only. |
| `conf/mysql/`, `functions/mysql.sh`, `samples/mysql/` | Postgres-only. |

### From Zero (`apps/email/server/`)

| Removed | Why |
|---|---|
| `src/lib/driver/google.ts`, `src/lib/driver/microsoft.ts` | Replaced by `src/lib/driver/imap.ts`. |
| `mail0_account`, `mail0_connection`, `mail0_oauth_*`, `mail0_jwks`, `mail0_early_access`, `mail0_verification` tables | Existed for Gmail/Outlook OAuth - N/A self-hosted. |
| tRPC routes that talk Gmail OAuth / Outlook Graph | N/A. |
| Better Auth's OAuth provider machinery | Auth now goes against Dovecot. |
| Zero's own `src/db/schema.ts` (the `mail0_*` definitions) | Replaced by `packages/db-email`. |

### What stays from iRedMail engine (the irreducible core)

| Component | Role | Owns DB |
|---|---|---|
| **Postfix** | SMTP server. Reads `vmail.*` (domains, mailboxes, forwardings, BCCs, relayhosts). | (uses `vmail`) |
| **Dovecot** | IMAP / POP3 / LMTP / ManageSieve / LDA. Reads `vmail.mailbox`, `vmail.domain`. Writes `vmail.last_login`, `vmail.used_quota`, `vmail.share_folder`. | (uses `vmail`) |
| **Amavisd** | Mail filtering bridge. Invokes ClamAV + SpamAssassin. | `amavisd` |
| **iRedAPD** | Policy daemon (greylisting, throttling, SRS). | `iredapd` |
| **ClamAV** | Antivirus. Signature database on a bind mount, seeded from the image on first boot — clamd will not start without it. | - |
| **SpamAssassin** | Spam scoring. Stateless. | - |
| **fail2ban** | Brute-force protection on SMTP/IMAP/POP3 auth. | `fail2ban` |

---

## Data flow examples

### Creating a mailbox

```
1. openship admin opens "Email > Users" page in dashboard.
2. Clicks "New mailbox" → form posts to openship API.
3. openship API uses @repo/db-email's Drizzle client to:
     INSERT INTO vmail.mailbox (...)
   plus triggers Maildir creation on the mail VPS via SSH.
4. Next time Postfix receives mail for that address, it queries
   vmail.mailbox via the SQL map file (which iRedMail's installer wrote),
   finds the row, delivers.
```

No daemon restart. No iRedAdmin. No HTTPS hop from openship to the mail VPS.
openship and the mail VPS share a Postgres - openship writes, daemons read.

### User opens their inbox

```
1. User goes to mail.example.com → Zero client.
2. Zero client prompts login → user enters alice@acme.com + password.
3. Zero server makes IMAP LOGIN to Dovecot:993 on the same VPS.
4. Dovecot queries vmail.mailbox via dovecot-sql.conf (iRedMail-generated),
   validates password.
5. Zero client now talks IMAP to Dovecot directly for inbox listing.
6. When user opens an email, Zero server fetches the message body
   via IMAP and renders it.
7. UI state (read/unread, hotkeys, etc.) writes to mail_app.* tables.
```

No Gmail. No OAuth. No `mail0_account` row. The IMAP+password IS the auth.

### Deleting a mailbox

```
1. openship admin → "Delete" on the user.
2. openship API runs (via @repo/db-email):
   a. UPDATE vmail.mailbox SET active=0 (Postfix stops delivering).
   b. INSERT INTO vmail.deleted_mailboxes (admin, username, ...)
      with delete_date in the future.
3. A cron job on the mail VPS reads vmail.deleted_mailboxes, removes the
   on-disk Maildir, then DELETE FROM vmail.mailbox.
4. mail_app.* rows for that user are cascade-deleted by FK.
```

This is iRedMail's existing two-phase delete pattern. We don't reinvent it.

---

## Routing

iRedMail's nginx is replaced by openship's existing routing layer:

| Public hostname | Routes to | What it serves |
|---|---|---|
| `mail.<domain>` | Zero client (Cloudflare Workers or Node) | Web inbox UI |
| `api.mail.<domain>` | Zero server | tRPC for Zero client (user-facing only) |
| `autodiscover.<domain>` | openship controller | Outlook autodiscover XML |
| `mailservice.<domain>` MX record | The mail VPS's public IP | SMTP, port 25 |
| Direct ports `25 / 465 / 587 / 110 / 143 / 993 / 995 / 4190` | The mail VPS directly (no proxy) | Postfix + Dovecot |

There is intentionally **no public admin subdomain**. Admin operations run
inside openship's own API; openship's process holds the Drizzle credential
for the mail-server Postgres and writes there directly. No HTTP admin
surface to firewall, no token to rotate, no public attack surface for
mailbox provisioning.

The raw mail protocols (SMTP/IMAP/POP3) **cannot** go through HTTP-level
routing - they speak their own TCP protocols. The mail VPS must have its
public IP exposed and `mailservice.<domain>` must have an A record pointing
at it.

---

## Repository layout (target)

```
apps/email/
├── ARCHITECTURE.md                   ← this file
├── package.json                      ← orchestrator (exists)
├── engine/                           ← iRedMail, slimmed
│   ├── iRedMail.sh                   ← drives daemon install + config gen
│   ├── conf/global                   ← env vars; gates set so iRedAdmin/SOGo/Roundcube/MySQL/LDAP are NO
│   ├── conf/postfix, dovecot, amavisd, clamav, spamassassin, iredapd, fail2ban
│   ├── functions/postgresql.sh       ← MODIFIED: detects existing vmail DB, skips creation
│   ├── functions/postfix.sh, dovecot.sh, amavisd.sh, …  ← unchanged
│   └── samples/postfix/pgsql/, samples/dovecot/, …      ← unchanged; iRedMail substitutes env vars
├── server/                           ← Zero, slimmed
│   ├── src/lib/driver/imap.ts        ← NEW driver
│   └── (Gmail/Outlook drivers + OAuth tables deleted)
└── client/                           ← Zero web UI

packages/
├── db/                               ← openship's existing schema (untouched)
└── db-email/                         ← DONE
    ├── src/
    │   ├── schema/
    │   │   ├── vmail.ts              ← byte-faithful port of iRedMail's pgsql
    │   │   └── mail_app.ts           ← Zero app-state, slimmed
    │   ├── client.ts                 ← drizzle client bound to VMAIL_DATABASE_URL
    │   └── index.ts
    ├── drizzle/0000_*.sql            ← initial migration
    ├── drizzle.config.ts
    └── package.json
```

**Note:** no `packages/email-config/`. iRedMail's installer keeps owning that.

---

## Phase ordering

| Phase | Scope | Verifies |
|---|---|---|
| **0. Doc** | This file. | Shared understanding. |
| **1. Schema port** | `packages/db-email/` with `vmail.*` + `mail_app.*`, drizzle migrations. | DONE - `drizzle-kit push` produces the expected DDL; engine untouched at this phase. |
| **2. Engine slim-down** | Delete iRedAdmin / SOGo / Roundcube / nginx / MySQL / OpenLDAP from `engine/`. Set `conf/global` flags so the installer skips them. | `iRedMail.sh` runs without installing the dropped components. |
| **3. Engine - vmail-DB reuse** | Patch `engine/functions/postgresql.sh` so it detects an existing `vmail` DB and skips its CREATE + schema-load. | Running the installer against a DB pre-populated by `db-email` migrations doesn't error or overwrite. |
| **4. Zero server: cut Gmail/Outlook + add IMAP driver** | Delete the OAuth tables / drivers. Add `src/lib/driver/imap.ts`. Point Zero at `packages/db-email`. | Zero client logs in against a manually-seeded `vmail.mailbox`. |
| **5. Openship admin module** | New `apps/api/src/modules/mail-server/admin/` - controllers + services that write to `vmail.*` via `@repo/db-email`. No HTTP roundtrip to the mail VPS. | curl from a test creates a mailbox; it appears in `vmail.mailbox` and Postfix delivers to it. |
| **6. Openship dashboard page** | New "Email > Users" page in openship dashboard that calls the openship admin module. | Visual flow: admin clicks "create user" → row exists in mail-server DB. |
| **7. Routing** | DONE - `packages/core/src/mail-server/routing` + `apps/api/src/modules/mail-server/routing`. | A user can log into Zero from a fresh browser, Outlook autodiscover works. |

This document covers Phase 0. Phase 1 has shipped (db-email).

---

## What we explicitly DO NOT build

- A TypeScript config generator for Postfix/Dovecot/Amavis. iRedMail's
  shell-based installer is the orchestrator and it works.
- A Drizzle schema for amavisd / iredapd / fail2ban. Their upstreams own
  those.
- An iRedAdmin replacement that's separate from openship's dashboard. The
  openship "Email" page IS the admin UI.
- A user-signup flow for mail accounts. Accounts are admin-provisioned only.
- A shared user table between openship and email. They're separate
  identities; openship admins create mailboxes for OTHER people (or
  themselves separately).
