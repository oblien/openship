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
# Called by entrypoint.sh AFTER the password reconcile and the wait-for-sidecar.
set -uo pipefail
log() { echo "[db-bootstrap] $*"; }

ENGINE=/opt/iRedMail-engine
SAMPLES="$ENGINE/samples"
WORK=/tmp/mailboot.d
rm -rf "$WORK"; mkdir -p "$WORK"

DB_HOST="${OPENSHIP_MAIL_DB_HOST:-127.0.0.1}"
DB_PORT="${OPENSHIP_MAIL_DB_PORT:-5432}"
export PGPASSWORD="${PGSQL_ROOT_PASSWD:-}"
psql_su() { psql -h "$DB_HOST" -p "$DB_PORT" -U postgres -v ON_ERROR_STOP=1 "$@"; }

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

# ── 0. idempotency gate — vmail schema already present? ───────────────────────
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

export DOMAIN_ADMIN_PASSWD_HASH="$(doveadm pw -s SSHA512 -p "$DOMAIN_ADMIN_PASSWD_PLAIN" 2>/dev/null)"

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
  for f in "$@"; do [ -f "$f" ] && psql_su -d "$db" -f "$f"; done
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
else log "WARN: iredapd schema missing at $IREDAPD_SQL"; ls -la /opt/iredapd 2>/dev/null; fi

# ── 5. fail2ban ───────────────────────────────────────────────────────────────
if [ -f "$SAMPLES/fail2ban/sql/fail2ban.pgsql" ]; then
  log "fail2ban DB"
  make_db fail2ban fail2ban "$SAMPLES/fail2ban/sql/fail2ban.pgsql"
else log "WARN: fail2ban schema missing"; fi

log "── DB bootstrap complete ──"
psql_su -d "$VMAIL_DB_NAME" -tAc "SELECT 'vmail.domain='||count(*) FROM domain"
psql_su -d "$VMAIL_DB_NAME" -tAc "SELECT 'vmail.mailbox='||count(*) FROM mailbox"
psql_su -d "$VMAIL_DB_NAME" -tAc "SELECT 'seeded_domain='||domain FROM domain LIMIT 1"
psql_su -d postgres -tAc "SELECT 'databases='||string_agg(datname,',' ORDER BY datname) FROM pg_database WHERE datname IN ('vmail','amavisd','iredapd','fail2ban')"
