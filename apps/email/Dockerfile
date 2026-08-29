# syntax=docker/dockerfile:1
# ─── openship-mail ───────────────────────────────────────────────────────────
# The mail ENGINE as a container: the slimmed iRedMail daemon set
# (Postfix, Dovecot, Amavis[+DKIM], ClamAV, SpamAssassin, iRedAPD, fail2ban)
# supervised by supervisord, with the vmail database in a separate
# `postgres:16-alpine` SIDECAR (see packages/adapters ensure-container-mail.ts).
#
# Run host-networked (`--network host --cap-add NET_ADMIN`) so Postfix/Dovecot
# bind the mail ports on the host NIC and see the real client IP — the edge is
# HTTP-only and never in the mail data path. All mutable state is on host bind
# mounts (MAIL_CONTAINER_MOUNTS) so `docker pull` + recreate never loses data.
#
# NOTE: iRedMail's installer assumes systemd and, for PGSQL, provisions a LOCAL
# Postgres. Here we stub systemctl at build and run the daemons under supervisord
# at runtime; the vmail DB is bootstrapped by the entrypoint against the SIDECAR
# (127.0.0.1:5432) rather than a local pg. The schema-load path is the remaining
# runtime seam (see entrypoint.sh) — the installer + package set below ARE
# validated on a Debian build host and the daemon binaries are asserted at build
# time by the smoke test after the install step.
#
# GOTCHA (was issue #493): iRedMail's `check_hostname` aborts with exit 255 unless
# the hostname is an FQDN. `bash` re-derives $HOSTNAME from the build machine's
# short hostname on startup, so exporting HOSTNAME does NOT survive into the
# installer. The installer's own knob is IREDMAIL_HOSTNAME (conf/global) — set it.
# Without this the installer exited early, `|| true` swallowed it, and the image
# shipped with NO mail stack (all tags byte-identical ~192MB, nothing on :25).
# ─────────────────────────────────────────────────────────────────────────────
FROM debian:12-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LC_ALL=C.UTF-8 \
    LANG=C.UTF-8

# Runtime + build prerequisites. supervisor = PID-1 process manager (iRedMail's
# daemons have no systemd here); postgresql-client + netcat = the entrypoint's
# wait-for-sidecar + schema bootstrap; the rest are iRedMail.sh's own deps.
RUN apt-get update && apt-get install -y --no-install-recommends \
      supervisor ca-certificates curl gnupg procps rsync cron \
      netcat-openbsd postgresql-client bsdmainutils \
    && rm -rf /var/lib/apt/lists/*

# Stub systemctl/service during the build so iRedMail.sh's `systemctl enable/start`
# calls succeed (there is no init at build time). supervisord owns process
# lifecycle at runtime; these stubs only matter to the installer.
RUN printf '#!/bin/sh\nexit 0\n' > /usr/local/sbin/systemctl \
    && printf '#!/bin/sh\nexit 0\n' > /usr/local/sbin/service \
    && chmod +x /usr/local/sbin/systemctl /usr/local/sbin/service

# The slimmed engine tree (already slimmed in-repo; see scripts/slim-engine.ts).
COPY apps/email/engine /opt/iRedMail-engine
# Baked build config + supervisord programs + first-boot entrypoint.
COPY apps/email/docker/ /opt/openship-mail/

# Run the iRedMail installer at BUILD time to lay down the Postfix/Dovecot/Amavis/
# ClamAV/SpamAssassin/iRedAPD configs. The build config points the SQL backend at
# 127.0.0.1 (the runtime sidecar) and carries placeholder secrets that the
# entrypoint overwrites on first boot from the per-install --env-file. The DB
# itself is NOT created here (no sidecar at build) — the entrypoint loads the
# schema into the sidecar on first boot.
# Two things are required for this step to actually install the stack (issue #493):
#
#   1. IREDMAIL_HOSTNAME — satisfies check_hostname's FQDN requirement (GOTCHA above).
#   2. `apt-get update` FIRST — iRedMail's pkgs/get_all.sh installs its own bootstrap
#      tools (wget, dialog, dirmngr) and fetches the iRedAPD tarball with `wget`
#      BEFORE it runs its own `apt update`. The base image's Step-3 layer ends with
#      `rm -rf /var/lib/apt/lists/*`, so without a refresh here that bootstrap install
#      finds no candidates, `wget` never lands, the tarball fetch dies, and get_all.sh
#      aborts — leaving the image with no mail stack. We repopulate the lists and
#      install those bootstrap tools explicitly so the fetch never depends on
#      get_all.sh's fragile pre-update ordering, then trim the lists again at the end.
#
# We keep `|| true` on the installer itself because its exit status is NOT a
# reliable success signal here: with systemd stubbed and no build-time Postgres,
# late service/DB steps exit non-zero even when every package installed fine. The
# real gate is the smoke test in the next layer, which fails the build loudly if
# any daemon binary is missing — so a binary-less image can never ship silently.
RUN cp /opt/openship-mail/build-config /opt/iRedMail-engine/config \
    && apt-get update \
    && apt-get install -y --no-install-recommends wget dialog dirmngr \
    && cd /opt/iRedMail-engine \
    && AUTO_USE_EXISTING_CONFIG_FILE=y \
       AUTO_INSTALL_WITHOUT_CONFIRM=y \
       AUTO_CLEANUP_REMOVE_SENDMAIL=y \
       AUTO_CLEANUP_REPLACE_FIREWALL_RULES=n \
       AUTO_CLEANUP_RESTART_FIREWALL=n \
       AUTO_CLEANUP_REPLACE_MYSQL_CONFIG=n \
       CHECK_NEW_IREDMAIL=NO \
       IREDMAIL_HOSTNAME=mail.build.invalid \
       bash iRedMail.sh || true \
    && rm -f /opt/iRedMail-engine/config \
    && rm -rf /var/lib/apt/lists/*

# Smoke test — the build FAILS here if the mail stack didn't actually install.
# Every path below is a program supervisord launches at runtime (supervisord.conf);
# an image that passes this test is guaranteed to have something to put on :25.
# NB: Debian's amavisd-new package ships the daemon as /usr/sbin/amavisd (there is
# no `amavisd-new` executable), which is why supervisord invokes /usr/sbin/amavisd.
#
# `doveadm` is not a supervisord program but is gated with them anyway, because three
# separate paths are dead without it: db-bootstrap.sh hashes the postmaster password,
# and the control plane hashes on every mailbox create and postmaster rotation. It
# arrives only as a transitive dependency of the dovecot packages iRedMail installs
# (packages.sh names dovecot-imapd/pop3d/lmtpd/managesieved/sieve/pgsql, never
# dovecot-core), so nothing guaranteed it was here. Its absence used to surface as a
# postmaster row with an EMPTY password and a 500 on mailbox create (GH-562) — a
# runtime mystery for a property the build can simply assert.
RUN set -eu; \
    missing=""; \
    for b in /usr/sbin/postfix /usr/sbin/dovecot /usr/bin/doveadm /usr/sbin/amavisd \
             /usr/sbin/clamd /usr/bin/freshclam /usr/sbin/spamd \
             /usr/bin/fail2ban-server /opt/iredapd/iredapd.py; do \
      [ -e "$b" ] || missing="$missing $b"; \
    done; \
    if [ -n "$missing" ]; then \
      echo "FATAL: iRedMail install left mail binaries missing:$missing" >&2; \
      echo "The openship-mail image would ship with no mail stack (issue #493)." >&2; \
      exit 1; \
    fi; \
    doveadm pw -s SSHA512 -p build-smoke-test | grep -q '^{SSHA512}' || { \
      echo "FATAL: doveadm is present but cannot produce an SSHA512 hash." >&2; \
      echo "Mailbox creation and the postmaster seed both depend on it (GH-562)." >&2; \
      exit 1; \
    }; \
    echo "openship-mail: all mail daemons present ->$(echo ' postfix dovecot doveadm amavisd clamd freshclam spamd fail2ban iredapd')"

# Runtime prerequisites the installer does not leave in place under our stubbed-
# init build (its late service/DB steps abort — see the `|| true` above):
#   1. the `iredapd` service account iRedAPD drops privileges to. Without it,
#      iredapd.py's getpwnam('iredapd') raises KeyError and the daemon FATALs on
#      every supervisord start. Create it + its log dir and hand it /opt/iredapd.
#   2. rsyslog's imklog module reads /proc/kmsg, which an unprivileged container
#      cannot open — disable it so rsyslogd (started first by supervisord to
#      create /dev/log for the mail daemons and iRedAPD) comes up cleanly.
#   3. /var/log/dovecot so Dovecot's syslog target dir exists from first boot.
RUN set -eu; \
    getent group iredapd >/dev/null || groupadd -r iredapd; \
    getent passwd iredapd >/dev/null || \
      useradd -r -g iredapd -d /opt/iredapd -s /usr/sbin/nologin iredapd; \
    mkdir -p /var/log/iredapd /var/log/dovecot; \
    chown -R iredapd:iredapd /var/log/iredapd /opt/iredapd 2>/dev/null || true; \
    if [ -f /etc/rsyslog.conf ]; then \
      sed -i 's/^[[:space:]]*module(load="imklog")/#module(load="imklog")/' /etc/rsyslog.conf; \
    fi

# Preserve the baked config OUTSIDE the mount paths so the entrypoint can
# seed-if-absent into empty bind mounts on first boot (a bind mount over
# /etc/postfix would otherwise hide the built config).
RUN mkdir -p /opt/openship-mail/seed \
    && cp -a /etc/postfix       /opt/openship-mail/seed/postfix      2>/dev/null || true \
    && cp -a /etc/dovecot       /opt/openship-mail/seed/dovecot      2>/dev/null || true \
    && cp -a /etc/amavis/conf.d /opt/openship-mail/seed/amavis-confd 2>/dev/null || true \
    && chmod +x /opt/openship-mail/entrypoint.sh /opt/openship-mail/postfix-chroot-etc.sh

# ClamAV signatures, fetched into the SEED dir (issue #565).
#
# /var/lib/clamav is a host bind mount at runtime, so a database written there during
# the build is hidden the moment the container starts: clamd finds an empty database
# directory and exits 1. That is not a degraded scanner — amavis's only scanner is
# clamd and @av_scanners_backup is empty, so every inbound message fails its virus
# check and defers. Seeding from here means a fresh install scans with no network and
# no multi-hundred-MB wait during setup.
#
# Fetched here rather than moved out of /var/lib/clamav after the installer: layers are
# additive, so a `mv` in a later layer keeps the originals in the installer's layer and
# ships them twice. build-config turns the installer's own freshclam off, which is why
# the image's /var/lib/clamav is now intentionally EMPTY — unmounted debugging
# (`docker run --entrypoint sh`) gets a clamd with no database.
#
# The retry is not defensive coding: database.clamav.net rate-limits CI egress, and the
# gate below is a hard build failure, so one 429 would block an entire release. Each
# attempt resumes into the same datadir. freshclam folds mirror and "could not notify
# clamd" warnings into its exit status, so the FILE CHECK is the real gate.
RUN set -eu; \
    getent passwd clamav >/dev/null || { \
      echo "FATAL: no clamav user — clamav-base did not install (issue #565)." >&2; \
      exit 1; \
    }; \
    install -d -o clamav -g clamav /var/log/clamav /opt/openship-mail/seed/clamav; \
    for attempt in 1 2 3; do \
      if freshclam --datadir=/opt/openship-mail/seed/clamav; then break; fi; \
      echo "openship-mail: freshclam attempt ${attempt} failed, retrying in 30s" >&2; \
      sleep 30; \
    done; \
    seeded=""; \
    for db in main.cvd main.cld daily.cvd daily.cld; do \
      [ -s "/opt/openship-mail/seed/clamav/$db" ] || continue; \
      seeded="$seeded $db"; \
    done; \
    if [ -z "$seeded" ]; then \
      echo "FATAL: no ClamAV signature database in /opt/openship-mail/seed/clamav." >&2; \
      echo "freshclam fetched neither main nor daily, so the image would ship a clamd" >&2; \
      echo "that cannot start and an amavis that defers all inbound mail (issue #565)." >&2; \
      exit 1; \
    fi; \
    echo "openship-mail: ClamAV signature seed ->$seeded"

# Mail protocol ports (bound on the host via --network host at runtime):
#   25 SMTP  465 SMTPS  587 submission  143 IMAP  993 IMAPS  110/995 POP3  4190 sieve
EXPOSE 25 465 587 143 993 110 995 4190

STOPSIGNAL SIGTERM

ENTRYPOINT ["/opt/openship-mail/entrypoint.sh"]
CMD ["/usr/bin/supervisord", "-c", "/opt/openship-mail/supervisord.conf"]
