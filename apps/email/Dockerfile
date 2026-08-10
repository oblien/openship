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
# NOTE (Linux-build required to finalize): iRedMail's installer assumes systemd
# and, for PGSQL, provisions a LOCAL Postgres. Here we stub systemctl at build
# and run the daemons under supervisord at runtime; the vmail DB is bootstrapped
# by the entrypoint against the SIDECAR (127.0.0.1:5432) rather than a local pg.
# The exact iRedMail invocation + schema-load must be validated on a Debian build
# host — this Dockerfile encodes the approach and the seams; it is not a build
# that has been run on macOS.
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
#   Validation seam: confirm iRedMail completes non-interactively with the local
#   Postgres steps neutralized (or run + discarded). Iterate on a Debian host.
RUN cp /opt/openship-mail/build-config /opt/iRedMail-engine/config \
    && cd /opt/iRedMail-engine \
    && AUTO_USE_EXISTING_CONFIG_FILE=y \
       AUTO_INSTALL_WITHOUT_CONFIRM=y \
       AUTO_CLEANUP_REMOVE_SENDMAIL=y \
       AUTO_CLEANUP_REPLACE_FIREWALL_RULES=n \
       AUTO_CLEANUP_RESTART_FIREWALL=n \
       AUTO_CLEANUP_REPLACE_MYSQL_CONFIG=n \
       CHECK_NEW_IREDMAIL=NO \
       bash iRedMail.sh || true \
    && rm -f /opt/iRedMail-engine/config

# Preserve the baked config OUTSIDE the mount paths so the entrypoint can
# seed-if-absent into empty bind mounts on first boot (a bind mount over
# /etc/postfix would otherwise hide the built config).
RUN mkdir -p /opt/openship-mail/seed \
    && cp -a /etc/postfix       /opt/openship-mail/seed/postfix      2>/dev/null || true \
    && cp -a /etc/dovecot       /opt/openship-mail/seed/dovecot      2>/dev/null || true \
    && cp -a /etc/amavis/conf.d /opt/openship-mail/seed/amavis-confd 2>/dev/null || true \
    && chmod +x /opt/openship-mail/entrypoint.sh

# Mail protocol ports (bound on the host via --network host at runtime):
#   25 SMTP  465 SMTPS  587 submission  143 IMAP  993 IMAPS  110/995 POP3  4190 sieve
EXPOSE 25 465 587 143 993 110 995 4190

STOPSIGNAL SIGTERM

ENTRYPOINT ["/opt/openship-mail/entrypoint.sh"]
CMD ["/usr/bin/supervisord", "-c", "/opt/openship-mail/supervisord.conf"]
