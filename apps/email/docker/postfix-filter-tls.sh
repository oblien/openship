#!/usr/bin/env bash
# Repair the persisted master.cf on every boot, including existing installs.
# Only the local content filter is plaintext; relay TLS remains mandatory.
set -euo pipefail
postconf -P \
  'smtp-amavis/unix/smtp_tls_security_level=none' \
  'smtp-amavis/unix/smtp_tls_wrappermode=no'
