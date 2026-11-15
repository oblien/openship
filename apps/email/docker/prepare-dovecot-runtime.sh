#!/usr/bin/env bash
# Run once at container boot, before supervisord starts any mail daemon.
# docker restart retains /run in the writable layer. A stale PID can now name
# another process, making Dovecot refuse to start with "Dovecot is already
# running" instead of listening on 993/995.
# The fresh PID namespace has no surviving Dovecot; the pid file is not mail
# data. Do not call this against an already running Dovecot process.
set -euo pipefail

rm -f /var/run/dovecot/master.pid
# No directory step: unlike Amavis, Dovecot creates /var/run/dovecot itself
# on first boot, so there is nothing to recreate after a recreate, and a
# restart leaves the directory's ownership untouched.
