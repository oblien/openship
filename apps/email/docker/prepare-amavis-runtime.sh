#!/usr/bin/env bash
# Run once at container boot, before supervisord starts any mail daemon.
# docker restart retains /run in the writable layer. A stale PID can now name
# another process, making Amavis abort instead of listening on 10024/10026.
# The fresh PID namespace has no surviving Amavis; these runtime files are not
# mail data. Do not call this against an already running Amavis process.
set -euo pipefail

if getent passwd amavis >/dev/null 2>&1; then
  rm -f /var/run/amavis/amavisd.pid /var/run/amavis/amavisd.lock /var/run/amavis/amavisd.socket
  # Debian's systemd tmpfiles rule does not run under supervisord. Recreate the
  # directory after a recreate, and repair ownership/mode after a restart.
  install -d -m 0750 -o amavis -g amavis /var/run/amavis
fi
