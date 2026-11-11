#!/usr/bin/env bash
# /var/log is persistent and may initially be empty, or retain old numeric UIDs.
set -euo pipefail

mkdir -p /var/log/dovecot /var/log/iredapd /var/log/supervisor
touch /var/log/mail.log \
      /var/log/dovecot/dovecot.log /var/log/dovecot/imap.log \
      /var/log/dovecot/pop3.log /var/log/dovecot/lda.log /var/log/dovecot/sieve.log \
      /var/log/iredapd/iredapd.log
if getent passwd iredapd >/dev/null 2>&1; then
  chown -R iredapd:iredapd /var/log/iredapd
fi
if getent passwd clamav >/dev/null 2>&1; then
  install -d -m 0755 -o clamav -g clamav /var/log/clamav
  touch /var/log/clamav/freshclam.log
  chown -R clamav:clamav /var/log/clamav
fi
