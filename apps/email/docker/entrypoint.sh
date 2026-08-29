#!/usr/bin/env bash
# First-boot / every-boot entrypoint for the openship-mail engine.
#
# Idempotent by construction — this is what makes `docker pull` + recreate safe:
#   1. seed-if-absent: copy baked config into empty bind mounts, never overwrite
#      operator edits (config dirs are host bind mounts; the queue/maildir/DKIM
#      data dirs start empty and are left alone — except ClamAV's signature
#      database, which is data clamd cannot start without: see 7).
#   2. reconcile the persistent Postfix chroot's DNS/NSS files from the running
#      container. The spool bind mount hides the copy made during image build;
#      without this, chrooted smtpd rejects inbound mail when DNS checks run.
#   3. reconcile: rewrite the baked placeholders in every daemon config to the
#      real per-install values from the --env-file — the `build-placeholder` DB
#      password (shared role) and the `build.invalid` domain (-> $FIRST_DOMAIN),
#      the latter also writing /etc/mailname + an /etc/hosts FQDN entry.
#   4. bootstrap the mail databases (roles + schema + first domain) if the vmail
#      schema isn't there yet — see db-bootstrap.sh, which owns the wait for the
#      sidecar and never re-inits an existing DB. FATAL on failure: an engine
#      without its schema cannot serve, and pretending otherwise is GH-562.
#   5. pre-create the log files fail2ban tails (rsyslog fills them once daemons
#      log; a jail whose logpath is missing at start would crash-loop).
#   6. reuse-or-generate the DKIM key on its bind mount (never regenerate — a new
#      selector breaks DMARC until DNS repropagates).
#   7. ClamAV: seed the signature database onto its bind mount from the baked copy
#      (no network), hand the mount to the `clamav` user, and create clamd's socket
#      directory. Without a database clamd exits 1, and amavis — whose only scanner
#      it is — then defers every inbound message (issue #565).
#   7. hand off to supervisord (the CMD).
#
# Env (from ensure-container-mail.ts --env-file): FIRST_DOMAIN,
# OPENSHIP_MAIL_DB_{HOST,PORT,NAME,USER}, plus iRedMail secrets
# (VMAIL_DB_ADMIN_PASSWD, VMAIL_DB_BIND_PASSWD, AMAVISD_DB_PASSWD,
# IREDAPD_DB_PASSWD, FAIL2BAN_DB_PASSWD, PGSQL_ROOT_PASSWD, DOMAIN_ADMIN_PASSWD_PLAIN).
set -euo pipefail

log() { echo "[openship-mail] $*"; }

# No DB_HOST/DB_PORT here on purpose: db-bootstrap.sh reads the same two env vars and
# owns every conversation with the sidecar, so duplicating them invites the two files
# to disagree about where the database is.
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

# 2. Recreate the resolver view inside Postfix's persistent chroot on EVERY boot.
# The iRedMail installer does this at image-build time, but /var/spool/postfix is
# replaced by the queue bind mount at runtime. Refreshing rather than seed-once
# also follows Docker DNS changes after a container recreate (GH-686).
bash /opt/openship-mail/postfix-chroot-etc.sh /etc /var/spool/postfix/etc

# 3. reconcile baked placeholder secrets -> the real shared role password.
#    The image is built with `build-placeholder` in every daemon's DB config; all
#    five mail roles share one password (loopback-only sidecar; privsep via
#    GRANTs — see db-bootstrap.sh), so one global replace wires postfix/dovecot/
#    amavis/iredapd/fail2ban to the sidecar. Idempotent: once replaced there is no
#    placeholder left to match, so every later boot is a no-op.
if [ -n "${VMAIL_DB_BIND_PASSWD:-}" ]; then
  export _OPENSHIP_MAIL_PW="$VMAIL_DB_BIND_PASSWD"
  # Pipe grep straight into xargs, newline-delimited. A NUL-delimited list (grep
  # -Z / xargs -0) cannot round-trip through a shell variable — bash silently
  # drops NUL bytes, mashing every path into one bogus filename that rewrites
  # nothing. Config paths never contain spaces/newlines, so newline-split is safe.
  # Skip *.pyc: rewriting iRedAPD's compiled settings.pyc would corrupt it, and
  # it is redundant — Python recompiles it from settings.py (which we DO rewrite,
  # so its mtime is now newer). Deleting the stale .pyc below makes that certain.
  if grep -rl --exclude='*.pyc' 'build-placeholder' \
       /etc/postfix /etc/dovecot /etc/amavis /opt/iredapd /etc/fail2ban 2>/dev/null \
       | xargs -r perl -pi -e 's/\Qbuild-placeholder\E/$ENV{_OPENSHIP_MAIL_PW}/g'; then
    log "reconciled DB passwords in daemon configs"
  else
    log "no placeholder passwords to reconcile"
  fi
  rm -f /opt/iredapd/__pycache__/*.pyc 2>/dev/null || true
  unset _OPENSHIP_MAIL_PW
fi

# 3b. reconcile the baked placeholder DOMAIN -> the real FIRST_DOMAIN.
#     The image is built with FIRST_DOMAIN=build.invalid (docker/build-config), so
#     every config iRedMail laid down at build carries `build.invalid` /
#     `mail.build.invalid` — most importantly amavis's
#     `dkim_key('build.invalid', 'dkim', '/var/lib/dkim/build.invalid.pem')`, whose
#     key never exists on the fresh DKIM bind mount. Left as-is `amavisd` aborts
#     loading its own config ("Can't open PEM file …/build.invalid.pem") and DKIM
#     retrieval (setup step 6) fails. One token replace fixes the dkim_key directive
#     AND postfix myhostname/mydomain at once (`mail.build.invalid` ->
#     `mail.$FIRST_DOMAIN`, `build.invalid` -> `$FIRST_DOMAIN`); the DKIM step below
#     then generates `/var/lib/dkim/$FIRST_DOMAIN.pem`, which the rewritten directive
#     now points at. Idempotent: once the token is gone every later boot no-ops — and
#     it still matches on an already-seeded broken mount, so `docker pull` + recreate
#     self-heals a server that halted here.
if [ -n "$FIRST_DOMAIN" ]; then
  # Same fail-closed charset guard as db-bootstrap.sh: FIRST_DOMAIN is spliced into
  # perl -e, /etc/mailname and /etc/hosts below, so a shell/regex metachar must never
  # reach them. A bad value skips the reconcile (db-bootstrap FATALs on it shortly)
  # rather than corrupting a config.
  case "$FIRST_DOMAIN" in
    *[!A-Za-z0-9.-]*|"")
      log "WARN: FIRST_DOMAIN '$FIRST_DOMAIN' outside [A-Za-z0-9.-] — skipping domain reconcile" ;;
    *)
      export _OPENSHIP_MAIL_DOMAIN="$FIRST_DOMAIN"
      # \Q…\E so the dot in build.invalid is literal, not a wildcard. Same file set +
      # *.pyc handling as the password reconcile above.
      if grep -rl --exclude='*.pyc' 'build\.invalid' \
           /etc/postfix /etc/dovecot /etc/amavis /opt/iredapd /etc/fail2ban 2>/dev/null \
           | xargs -r perl -pi -e 's/\Qbuild.invalid\E/$ENV{_OPENSHIP_MAIL_DOMAIN}/g'; then
        log "reconciled build.invalid -> ${FIRST_DOMAIN} in daemon configs"
      else
        log "no build.invalid placeholder to reconcile"
      fi
      rm -f /opt/iredapd/__pycache__/*.pyc 2>/dev/null || true
      unset _OPENSHIP_MAIL_DOMAIN

      # /etc/mailname — Debian's "system mail name" (postfix myorigin source). Not on
      # a bind mount and never written under the stubbed-init build, so it is missing
      # at runtime: the `head: cannot open '/etc/mailname'` line in the step-6 error.
      # Write the mail FQDN atomically (temp + rename) to match the reconciled
      # myhostname; a write failure is a warning, never fatal.
      printf 'mail.%s\n' "$FIRST_DOMAIN" > /etc/mailname.tmp \
        && mv -f /etc/mailname.tmp /etc/mailname \
        || log "WARN: could not write /etc/mailname"

      # /etc/hosts — give the container FQDN a resolvable entry so `hostname --fqdn`
      # (amavis/postfix call it at startup) stops failing with "Name or service not
      # known". Docker manages /etc/hosts and resets it on recreate, so add-once-per-
      # boot is correct; the -F guard keeps a within-boot re-run from duplicating.
      if ! grep -qF "mail.${FIRST_DOMAIN}" /etc/hosts 2>/dev/null; then
        printf '127.0.0.1 mail.%s mail\n' "$FIRST_DOMAIN" >> /etc/hosts \
          || log "WARN: could not append FQDN to /etc/hosts"
      fi
      ;;
  esac
fi

# 4. bootstrap the mail databases (idempotent; skips if the vmail schema exists).
#
# The wait for the sidecar lives INSIDE db-bootstrap.sh, which polls `SELECT 1` until
# the database actually answers. This used to be an `nc -z` loop here, and that was
# half of GH-562: a TCP probe succeeds as soon as postgres binds its port, which is
# before it will serve a query — so the bootstrap started against a database that was
# still initializing. The loop also fell through after 60 tries without checking, so an
# absent sidecar proceeded anyway. A weaker duplicate probe here would add nothing.
#
# A failure is FATAL rather than a log line. There is no case where this exits non-zero
# and the engine can still work: either the database is unreachable (no daemon can
# authenticate) or the schema did not load (dovecot, iredapd and amavis all crash on
# their first query). Continuing produced the reported symptom — every daemon
# crash-looping while the boot log claimed success. Dying here instead means the log
# names the cause once, and `verifyMailEngine`'s port probe correctly reports the
# engine as down instead of reporting a healthy install.
if ! bash /opt/openship-mail/db-bootstrap.sh; then
  log "FATAL: mail database bootstrap failed — see the [db-bootstrap] lines above."
  log "  The engine will not start without its schema. After fixing the cause, recreate"
  log "  the container, or re-run:  docker exec openship-mail bash /opt/openship-mail/db-bootstrap.sh"
  exit 1
fi

# 5. pre-create the log files the fail2ban jails tail, so a jail never starts
#    against a missing path (rsyslog populates them as the daemons log).
mkdir -p /var/log/dovecot /var/log/iredapd /var/log/supervisor
touch /var/log/mail.log \
      /var/log/dovecot/dovecot.log /var/log/dovecot/imap.log \
      /var/log/dovecot/pop3.log /var/log/dovecot/lda.log /var/log/dovecot/sieve.log \
      /var/log/iredapd/iredapd.log
chown -R iredapd:iredapd /var/log/iredapd 2>/dev/null || true

# 6. DKIM: reuse the key on the mount, else generate one (per domain).
if [ -n "$FIRST_DOMAIN" ] && [ ! -s "/var/lib/dkim/${FIRST_DOMAIN}.pem" ]; then
  log "generating DKIM key for ${FIRST_DOMAIN}"
  # Debian ships the daemon as `amavisd` (no `amavisd-new` executable); try it
  # first and keep the old name only as a fallback for non-Debian bases.
  amavisd genrsa "/var/lib/dkim/${FIRST_DOMAIN}.pem" 2048 || \
    amavisd-new genrsa "/var/lib/dkim/${FIRST_DOMAIN}.pem" 2048 || \
    log "WARN: DKIM keygen failed (no amavisd binary?)"
fi
chown -R amavis:amavis /var/lib/dkim 2>/dev/null || true

# 7. ClamAV: signatures onto the mount, and clamd's runtime directory.
#
#    The seed is NOT allowed to be fatal, unlike the config seeds above: this one copies
#    a few hundred MB onto a host bind mount, so a full or read-only disk would take
#    Postfix and Dovecot down with it. A missing virus scanner must not cost the box its
#    mail service.
seed clamav /var/lib/clamav \
  || log "WARN: could not seed ClamAV signatures — freshclam will fetch them"
#    Ownership is fixed on EVERY boot, not only when seeding: the mount is created
#    root-owned by ensure-container-mail, both daemons drop to the `clamav` user
#    (clamd.conf User, freshclam.conf DatabaseOwner), and Debian allocates that uid at
#    package-install time — so a rebuilt image can hand the same host directory a
#    different uid. Chowning by NAME is why this cannot be done host-side.
if getent passwd clamav >/dev/null 2>&1; then
  chown -R clamav:clamav /var/lib/clamav 2>/dev/null \
    || log "WARN: could not chown /var/lib/clamav — freshclam cannot write signatures"
  # clamd's LocalSocket (/var/run/clamav/clamd.ctl — what amavis connects to) and
  # freshclam's pid file live here. Debian creates this from the tmpfiles.d rule its
  # systemd units carry; under supervisord nothing does, and /run starts empty on every
  # recreate. clamd does not create it either — it fails to open its socket and exits.
  install -d -m 0755 -o clamav -g clamav /var/run/clamav \
    || log "WARN: could not create /var/run/clamav — clamd cannot open its socket"
else
  log "WARN: no clamav user in this image — ClamAV will not start"
fi

log "starting supervisord"
exec "$@"
