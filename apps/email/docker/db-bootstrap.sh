#!/usr/bin/env bash
# Bootstrap the mail databases into the openship-mail-db SIDECAR on first boot.
#
# Faithful to iRedMail's functions/postgresql.sh::pgsql_import_vmail_users, but
# adapted for our containerized topology:
#   - the `vmail` DB is PRE-CREATED by the sidecar (POSTGRES_DB=vmail), so we load
#     schema into it rather than CREATE it;
#   - each file is loaded directly with `-d <db>` as the postgres SUPERUSER, so we
#     STRIP the `\c` connect lines iRedMail uses when loading via template1;
#   - one shared internal role password (the sidecar listens on 127.0.0.1 only, so
#     the five mail roles share one secret and privilege separation is by GRANTs).
#
# Idempotent: a `mailbox` table in vmail means we already ran — exit early.
# Called by entrypoint.sh AFTER the password reconcile, and safe to re-run by hand.
#
# FAILURE SEMANTICS (GH-562). This script used to run under `set -uo pipefail` with no
# `-e`, so a psql that could not connect did not stop it: every step failed in turn and
# it still reached the closing "DB bootstrap complete" and exited 0. The caller's
# `|| log "ERROR"` could therefore never fire, and the operator saw daemons crash-loop
# against an empty database with nothing anywhere saying why. Two rules now hold:
#
#   1. `set -e` — any failed step aborts with a non-zero exit the caller can act on.
#   2. Nothing is assumed ready. We WAIT for the database to answer a real query (not
#      just accept a TCP connection) and fail loudly if it never does.
#
# The wait lives here rather than only in entrypoint.sh because the documented recovery
# is to run this script by hand, and it must be self-sufficient on that path too.
set -euo pipefail
log() { echo "[db-bootstrap] $*"; }
fatal() { echo "[db-bootstrap] FATAL: $*" >&2; exit 1; }

ENGINE=/opt/iRedMail-engine
SAMPLES="$ENGINE/samples"
WORK=/tmp/mailboot.d
rm -rf "$WORK"; mkdir -p "$WORK"

DB_HOST="${OPENSHIP_MAIL_DB_HOST:-127.0.0.1}"
DB_PORT="${OPENSHIP_MAIL_DB_PORT:-5432}"
export PGPASSWORD="${PGSQL_ROOT_PASSWD:-}"
# Bound the TCP connect. Without it the wait budget below is decorative: against a host
# that silently drops packets (a firewall, a wrong OPENSHIP_MAIL_DB_HOST) libpq blocks
# for the OS default — minutes per attempt — so a "180s" budget never gets to iterate
# and the operator watches the boot hang with no output at all. 5s is far above a
# loopback or same-host sidecar connect.
export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-5}"
psql_su() { psql -h "$DB_HOST" -p "$DB_PORT" -U postgres -v ON_ERROR_STOP=1 "$@"; }

# ── wait for the sidecar to ANSWER, not merely to listen ──────────────────────
# A TCP probe (`nc -z`) is not readiness: postgres binds its port before it can serve,
# and during initdb or crash recovery it accepts the connection then refuses the query
# with "the database system is starting up". That gap is the GH-562 race — the bootstrap
# began while the sidecar was still starting, so every statement failed. `SELECT 1`
# exercises DNS, TCP, auth AND readiness, which is exactly the set that can be late.
# Note the `if`s rather than `[ … ] && log …`: under `set -e` a false test as the last
# command of an AND-list aborts the script, so the terse form would exit on the very
# first (already-ready) probe.
wait_for_db() {
  local budget="${OPENSHIP_MAIL_DB_WAIT_SECS:-180}" waited=0
  until psql_su -d postgres -tAc 'SELECT 1' >/dev/null 2>&1; do
    if [ "$waited" -ge "$budget" ]; then
      fatal "the mail database at ${DB_HOST}:${DB_PORT} did not accept queries within ${budget}s.
  The sidecar is unreachable, still initializing, or rejecting our credentials.
  Check:  docker logs openship-mail-db
  A host process already on ${DB_PORT} is the most common cause."
    fi
    if [ "$waited" -eq 0 ]; then
      log "waiting for the mail database at ${DB_HOST}:${DB_PORT}..."
    fi
    sleep 2
    waited=$((waited + 2))
  done
  if [ "$waited" -gt 0 ]; then
    log "mail database answered after ${waited}s"
  fi
}

# ── iRedMail conventions (conf/global, conf/postfix, conf/dovecot) ────────────
export VMAIL_DB_NAME="${OPENSHIP_MAIL_DB_NAME:-vmail}"
export VMAIL_DB_BIND_USER=vmail
export VMAIL_DB_ADMIN_USER=vmailadmin
export STORAGE_BASE_DIR=/var/vmail
export STORAGE_NODE=vmail1
export TRANSPORT=dovecot
export DOMAIN_ADMIN_NAME=postmaster
export FIRST_DOMAIN="${FIRST_DOMAIN:?FIRST_DOMAIN required}"
# FIRST_DOMAIN is perl-substituted into the SQL templates below and those run as
# the postgres SUPERUSER, so a quote in it would be SQL injection (-> COPY FROM
# PROGRAM). The control plane already restricts the domain charset and refuses to
# write a multi-line env-file record, but this is the last line of defence and the
# only one that lives with the code that interpolates. Fail closed.
case "$FIRST_DOMAIN" in
  *[!A-Za-z0-9.-]*|"")
    echo "[mail-db] FATAL: FIRST_DOMAIN contains characters outside [A-Za-z0-9.-]" >&2
    exit 1
    ;;
esac
export DOMAIN_ADMIN_EMAIL="postmaster@${FIRST_DOMAIN}"
# hash_maildir --no-timestamp postmaster  ->  p/o/s/postmaster/  (MAILDIR_STYLE=hashed)
export DOMAIN_ADMIN_MAILDIR_HASH_PART="${FIRST_DOMAIN}/p/o/s/postmaster/"

# One shared internal role password. The sidecar listens on 127.0.0.1 only, so
# the five mail roles share one secret; privilege separation is enforced by
# GRANTs, not distinct passwords. (Per-role passwords = future hardening.)
export MAIL_DB_PW="${VMAIL_DB_BIND_PASSWD:?VMAIL_DB_BIND_PASSWD required}"

# ── 0. the database must be answering before anything below can mean anything ──
# Deliberately AFTER the env validation above: those checks are free, and failing them
# after a 3-minute wait would bury the real complaint.
wait_for_db

# ── 0b. idempotency gate — vmail schema already present? ──────────────────────
# The `2>/dev/null | grep -q 1` here is safe now that the DB is known-reachable: a
# missing table is the only thing an empty result can still mean.
if psql_su -d "$VMAIL_DB_NAME" -tAc \
     "SELECT 1 FROM information_schema.tables WHERE table_name='mailbox'" 2>/dev/null | grep -q 1; then
  log "vmail schema already present — skipping DB bootstrap"; exit 0
fi
log "bootstrapping mail databases (vmail, amavisd, iredapd, fail2ban)"

# ── 1. roles (idempotent create; converge password via psql :'pw', injection-safe)
psql_su -d postgres -v pw="$MAIL_DB_PW" <<'SQL'
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['vmail','vmailadmin','amavisd','iredapd','fail2ban'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE', r);
    END IF;
  END LOOP;
END $$;
ALTER ROLE vmail      PASSWORD :'pw';
ALTER ROLE vmailadmin PASSWORD :'pw';
ALTER ROLE amavisd    PASSWORD :'pw';
ALTER ROLE iredapd    PASSWORD :'pw';
ALTER ROLE fail2ban   PASSWORD :'pw';
SQL

# ── 2. vmail schema (DB pre-created by the sidecar; load tables + trigger) ─────
DOVE_VER="$(dovecot --version 2>/dev/null | grep -oE '^[0-9]+\.[0-9]+' || echo 2.3)"
TRIG="$SAMPLES/iredmail/used_quota_triggers_dovecot_${DOVE_VER}.pgsql"
[ -f "$TRIG" ] || TRIG="$SAMPLES/iredmail/used_quota_triggers_dovecot_2.3.pgsql"

cp -f "$SAMPLES/iredmail/iredmail.pgsql"                      "$WORK/iredmail.sql"
cp -f "$SAMPLES/postgresql/sql/grant_permissions.sql"        "$WORK/grant.sql"
cp -f "$SAMPLES/postgresql/sql/add_first_domain_and_user.sql" "$WORK/first.sql"
cp -f "$TRIG"                                                 "$WORK/trigger.sql"

# The postmaster's password hash. `2>/dev/null` used to hide the one failure that
# matters: if doveadm is missing or Dovecot's config is unreadable this produced an
# EMPTY string, which was then substituted into first.sql — seeding a postmaster with
# no password while the bootstrap reported success. Keep stderr, and refuse anything
# that isn't a well-formed SSHA512 hash.
DOMAIN_ADMIN_PASSWD_HASH="$(doveadm pw -s SSHA512 -p "$DOMAIN_ADMIN_PASSWD_PLAIN" || true)"
export DOMAIN_ADMIN_PASSWD_HASH
case "$DOMAIN_ADMIN_PASSWD_HASH" in
  '{SSHA512}'*) : ;;
  '') fatal "doveadm pw produced no output — is doveadm installed in this image?
  The postmaster account would have been created with an EMPTY password." ;;
  *) fatal "doveadm pw returned something that is not an SSHA512 hash: ${DOMAIN_ADMIN_PASSWD_HASH:0:40}…" ;;
esac

# iRedMail's exact PH_ substitutions ($ENV = safe for '.', '/', etc. in values).
for f in "$WORK/iredmail.sql" "$WORK/grant.sql" "$WORK/first.sql"; do
  perl -pi -e 's#PH_VMAIL_DB_NAME#$ENV{VMAIL_DB_NAME}#g'                 "$f"
  perl -pi -e 's#PH_VMAIL_DB_BIND_USER#$ENV{VMAIL_DB_BIND_USER}#g'      "$f"
  perl -pi -e 's#PH_VMAIL_DB_ADMIN_USER#$ENV{VMAIL_DB_ADMIN_USER}#g'    "$f"
  perl -pi -e 's#PH_FIRST_DOMAIN#$ENV{FIRST_DOMAIN}#g'                  "$f"
  perl -pi -e 's#PH_TRANSPORT#$ENV{TRANSPORT}#g'                        "$f"
  perl -pi -e 's#PH_DOMAIN_ADMIN_EMAIL#$ENV{DOMAIN_ADMIN_EMAIL}#g'      "$f"
  perl -pi -e 's#PH_DOMAIN_ADMIN_NAME#$ENV{DOMAIN_ADMIN_NAME}#g'        "$f"
  perl -pi -e 's#PH_DOMAIN_ADMIN_MAILDIR_HASH_PART#$ENV{DOMAIN_ADMIN_MAILDIR_HASH_PART}#g' "$f"
  perl -pi -e 's#PH_DOMAIN_ADMIN_PASSWD_HASH#$ENV{DOMAIN_ADMIN_PASSWD_HASH}#g' "$f"
done
# iRedMail sets the storagebasedirectory/storagenode column DEFAULTs in the DDL.
perl -pi -e 's#(.*storagebasedirectory.*DEFAULT..)(.*)#${1}$ENV{STORAGE_BASE_DIR}${2}#' "$WORK/iredmail.sql"
perl -pi -e 's#(.*storagenode.*DEFAULT..)(.*)#${1}$ENV{STORAGE_NODE}${2}#'               "$WORK/iredmail.sql"
# We load each file with `-d vmail` directly, so drop all \c connect lines
# (iRedMail instead UNCOMMENTS \c because it loads via template1).
for f in "$WORK/iredmail.sql" "$WORK/grant.sql" "$WORK/first.sql"; do
  perl -ni -e 'print unless /^\s*(--\s*)?\\c\b/' "$f"
done

log "vmail: tables"        ; psql_su -d "$VMAIL_DB_NAME" -f "$WORK/iredmail.sql"
log "vmail: quota trigger ($DOVE_VER)"; psql_su -d "$VMAIL_DB_NAME" -f "$WORK/trigger.sql"
log "vmail: grant bind-user (read)"   ; psql_su -d "$VMAIL_DB_NAME" -f "$WORK/grant.sql"
log "vmail: grant vmailadmin (write: dict quota / last-login)"
psql_su -d "$VMAIL_DB_NAME" <<'SQL'
GRANT ALL ON ALL TABLES IN SCHEMA public TO vmailadmin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO vmailadmin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO vmailadmin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO vmailadmin;
SQL
log "vmail: first domain + postmaster"; psql_su -d "$VMAIL_DB_NAME" -f "$WORK/first.sql"

# ── helper: create an owned DB (idempotent) + load schema + grant to its role ──
make_db() { # <db> <role> <schema-file> [extra-sql-files...]
  local db="$1" role="$2"; shift 2
  psql_su -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1 \
    || psql_su -d postgres -c "CREATE DATABASE $db WITH OWNER $role TEMPLATE template0 ENCODING 'UTF8'"
  local f
  # `if` rather than `[ -f "$f" ] && psql_su …`: under `set -e` the AND-list returns
  # non-zero for a missing optional file and would abort the whole bootstrap.
  for f in "$@"; do
    if [ -f "$f" ]; then psql_su -d "$db" -f "$f"; fi
  done
  psql_su -d "$db" <<SQL
GRANT ALL ON ALL TABLES IN SCHEMA public TO $role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO $role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO $role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO $role;
SQL
}

# ── 3. amavisd ────────────────────────────────────────────────────────────────
if [ -f "$SAMPLES/amavisd/amavisd.pgsql" ]; then
  log "amavisd DB"
  make_db amavisd amavisd "$SAMPLES/amavisd/amavisd.pgsql" "$SAMPLES/amavisd/default_spam_policy.sql"
else log "WARN: amavisd schema missing"; fi

# ── 4. iredapd (schema ships in the tarball at /opt/iredapd/SQL) ──────────────
IREDAPD_SQL=/opt/iredapd/SQL
if [ -f "$IREDAPD_SQL/iredapd.pgsql" ]; then
  log "iredapd DB"
  make_db iredapd iredapd "$IREDAPD_SQL/iredapd.pgsql" \
    "$IREDAPD_SQL/enable_global_greylisting.sql" \
    "$IREDAPD_SQL/greylisting_whitelist_domains.sql" \
    "$IREDAPD_SQL/wblist_rdns.sql"
else
  # `|| true` on the diagnostic: under `set -e` a bare `ls` of a directory that isn't
  # there exits 2 and would abort the bootstrap on its way to reporting a WARNING.
  log "WARN: iredapd schema missing at $IREDAPD_SQL"
  ls -la /opt/iredapd 2>/dev/null || true
fi

# ── 5. fail2ban ───────────────────────────────────────────────────────────────
if [ -f "$SAMPLES/fail2ban/sql/fail2ban.pgsql" ]; then
  log "fail2ban DB"
  make_db fail2ban fail2ban "$SAMPLES/fail2ban/sql/fail2ban.pgsql"
else log "WARN: fail2ban schema missing"; fi

# ── 6. verify, don't narrate ──────────────────────────────────────────────────
# These four reads used to print and nothing more, so "── DB bootstrap complete ──"
# was emitted whether or not a single statement above had worked. They are now
# ASSERTIONS: the script may only claim success if the seeded state is actually there.
seeded_domains="$(psql_su -d "$VMAIL_DB_NAME" -tAc "SELECT count(*) FROM domain")"
seeded_mailboxes="$(psql_su -d "$VMAIL_DB_NAME" -tAc "SELECT count(*) FROM mailbox")"
seeded_databases="$(psql_su -d postgres -tAc \
  "SELECT string_agg(datname,',' ORDER BY datname) FROM pg_database WHERE datname IN ('vmail','amavisd','iredapd','fail2ban')")"

log "vmail.domain=${seeded_domains} vmail.mailbox=${seeded_mailboxes} databases=${seeded_databases}"

[ "${seeded_domains:-0}" -ge 1 ] || fatal "vmail.domain is empty — the first domain was not seeded."
[ "${seeded_mailboxes:-0}" -ge 1 ] || fatal "vmail.mailbox is empty — the postmaster account was not created."

# An empty password column here is the failure this bootstrap used to ship silently.
if psql_su -d "$VMAIL_DB_NAME" -tAc \
     "SELECT 1 FROM mailbox WHERE username='${DOMAIN_ADMIN_EMAIL}' AND coalesce(password,'') = ''" | grep -q 1; then
  fatal "${DOMAIN_ADMIN_EMAIL} was created with an EMPTY password — refusing to report success."
fi

log "── DB bootstrap complete ──"
