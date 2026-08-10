#!/usr/bin/env bash
# First-boot / every-boot entrypoint for the openship-mail engine.
#
# Idempotent by construction — this is what makes `docker pull` + recreate safe:
#   1. seed-if-absent: copy baked config into empty bind mounts, never overwrite
#      operator edits (config dirs are host bind mounts; the queue/maildir/DKIM
#      data dirs start empty and are left alone).
#   2. wait for the postgres SIDECAR (127.0.0.1:5432).
#   3. bootstrap the vmail DB (roles + schema) if it isn't there yet, using the
#      per-install secrets delivered via --env-file; never re-init an existing DB.
#   4. reuse-or-generate the DKIM key on its bind mount (never regenerate — a new
#      selector breaks DMARC until DNS repropagates).
#   5. hand off to supervisord (the CMD).
#
# Env (from ensure-container-mail.ts --env-file): FIRST_DOMAIN,
# OPENSHIP_MAIL_DB_{HOST,PORT,NAME,USER}, plus iRedMail secrets
# (VMAIL_DB_ADMIN_PASSWD, VMAIL_DB_BIND_PASSWD, AMAVISD_DB_PASSWD,
# IREDAPD_DB_PASSWD, FAIL2BAN_DB_PASSWD, PGSQL_ROOT_PASSWD, DOMAIN_ADMIN_PASSWD_PLAIN).
set -euo pipefail

log() { echo "[openship-mail] $*"; }

DB_HOST="${OPENSHIP_MAIL_DB_HOST:-127.0.0.1}"
DB_PORT="${OPENSHIP_MAIL_DB_PORT:-5432}"
DB_NAME="${OPENSHIP_MAIL_DB_NAME:-vmail}"
FIRST_DOMAIN="${FIRST_DOMAIN:-}"
SEED_DIR="/opt/openship-mail/seed"

# 1. seed-if-absent for bind-mounted config dirs.
seed() { # <seed-subdir> <target>
  local src="$SEED_DIR/$1" dst="$2"
  if [ -d "$src" ] && [ -z "$(ls -A "$dst" 2>/dev/null || true)" ]; then
    log "seeding $dst from baked defaults"
    cp -a "$src/." "$dst/"
  fi
}
seed postfix /etc/postfix
seed dovecot /etc/dovecot
seed amavis-confd /etc/amavis/conf.d
mkdir -p /var/vmail /var/spool/postfix /var/lib/dkim /var/lib/clamav

# 2. wait for the sidecar DB.
log "waiting for the mail database at ${DB_HOST}:${DB_PORT}..."
for _ in $(seq 1 60); do
  if nc -z "$DB_HOST" "$DB_PORT" 2>/dev/null; then break; fi
  sleep 2
done
export PGPASSWORD="${PGSQL_ROOT_PASSWD:-}"
psql_root() { psql -h "$DB_HOST" -p "$DB_PORT" -U postgres -v ON_ERROR_STOP=1 "$@"; }

# 3. bootstrap the vmail DB if the schema isn't present yet.
#    Validation seam: the exact role list + schema load below mirror what
#    iRedMail's PGSQL backend creates; confirm against engine/samples on a Debian
#    build host and adjust the SQL template paths if they differ.
if ! psql_root -d "$DB_NAME" -tc "SELECT 1 FROM information_schema.tables WHERE table_name='mailbox'" 2>/dev/null | grep -q 1; then
  log "bootstrapping vmail database roles + schema"
  psql_root -d "$DB_NAME" <<SQL || log "WARN: vmail bootstrap reported errors (inspect on a Debian build host)"
    DO \$\$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='vmail') THEN
        CREATE ROLE vmail LOGIN PASSWORD '${VMAIL_DB_BIND_PASSWD:-}';
      END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='vmailadmin') THEN
        CREATE ROLE vmailadmin LOGIN PASSWORD '${VMAIL_DB_ADMIN_PASSWD:-}';
      END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='amavisd') THEN
        CREATE ROLE amavisd LOGIN PASSWORD '${AMAVISD_DB_PASSWD:-}';
      END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='iredapd') THEN
        CREATE ROLE iredapd LOGIN PASSWORD '${IREDAPD_DB_PASSWD:-}';
      END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='fail2ban') THEN
        CREATE ROLE fail2ban LOGIN PASSWORD '${FAIL2BAN_DB_PASSWD:-}';
      END IF;
    END \$\$;
SQL
  # Load iRedMail's vmail schema (tables + the FIRST_DOMAIN seed row). The engine
  # ships these SQL templates under conf/ / samples/; point at them here.
  for f in /opt/iRedMail-engine/samples/*vmail*.sql /opt/iRedMail-engine/conf/*vmail*.sql; do
    [ -f "$f" ] && psql_root -d "$DB_NAME" -f "$f" || true
  done
  if [ -n "$FIRST_DOMAIN" ]; then
    psql_root -d "$DB_NAME" -c \
      "INSERT INTO domain (domain, active) VALUES ('${FIRST_DOMAIN}', 1) ON CONFLICT DO NOTHING;" || true
  fi
fi

# 4. DKIM: reuse the key on the mount, else generate one (per domain).
if [ -n "$FIRST_DOMAIN" ] && [ ! -s "/var/lib/dkim/${FIRST_DOMAIN}.pem" ]; then
  log "generating DKIM key for ${FIRST_DOMAIN}"
  amavisd-new genrsa "/var/lib/dkim/${FIRST_DOMAIN}.pem" 2048 || \
    amavisd genrsa "/var/lib/dkim/${FIRST_DOMAIN}.pem" 2048 || \
    log "WARN: DKIM keygen failed (validate amavisd binary name on Debian)"
fi
chown -R amavis:amavis /var/lib/dkim 2>/dev/null || true

mkdir -p /var/log/supervisor
log "starting supervisord"
exec "$@"
