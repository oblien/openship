#!/usr/bin/env bash
# Reconnect the mail daemons to the operator's mounted certificates before boot.
# Optional path arguments allow the same reconciliation against an isolated root.
set -euo pipefail

MAIL_BASE_DOMAIN="${1:-}"
MAIL_CERT_ROOT="${2:-/etc/letsencrypt/live}"
MAIL_CERT_PATH="${3:-/etc/ssl/certs/iRedMail.crt}"
MAIL_KEY_PATH="${4:-/etc/ssl/private/iRedMail.key}"

case "$MAIL_BASE_DOMAIN" in
  ""|*[!A-Za-z0-9.-]*) exit 0 ;;
esac

MAIL_CERT_DIR=""
for candidate in "$MAIL_CERT_ROOT/mail.$MAIL_BASE_DOMAIN" "$MAIL_CERT_ROOT/$MAIL_BASE_DOMAIN"; do
  [ -s "$candidate/fullchain.pem" ] && [ -s "$candidate/privkey.pem" ] || continue

  # These are operator-managed certificates, not a new trust source. Validate
  # hostname, dates and server usage against the mounted leaf itself. An apex
  # certificate is usable only if it also covers mail.<domain> (SAN or wildcard).
  openssl verify -partial_chain -trusted "$candidate/fullchain.pem" \
    -purpose sslserver -verify_hostname "mail.$MAIL_BASE_DOMAIN" \
    "$candidate/fullchain.pem" >/dev/null 2>&1 || continue
  cert_public="$(openssl x509 -in "$candidate/fullchain.pem" -pubkey -noout 2>/dev/null)" || continue
  key_public="$(openssl pkey -in "$candidate/privkey.pem" -pubout -passin pass: 2>/dev/null)" || continue
  [ -n "$cert_public" ] && [ "$cert_public" = "$key_public" ] || continue
  MAIL_CERT_DIR="$candidate"
  break
done

# Keep the existing fallback/configuration intact when no usable pair is mounted.
[ -n "$MAIL_CERT_DIR" ] || exit 0

link_certificate() {
  local source="$1" destination="$2"
  # Compare the link itself, not readlink -f: Certbot's live links resolve to
  # versioned archive files, which necessarily differ from the stable live path.
  [ "$(readlink "$destination" 2>/dev/null || true)" != "$source" ] || return 0
  mkdir -p "$(dirname "$destination")"
  if [ -f "$destination" ] && [ ! -L "$destination" ] && [ ! -e "$destination.bak" ]; then
    cp -p "$destination" "$destination.bak"
  fi
  ln -sfn "$source" "$destination"
}

link_certificate "$MAIL_CERT_DIR/fullchain.pem" "$MAIL_CERT_PATH"
link_certificate "$MAIL_CERT_DIR/privkey.pem" "$MAIL_KEY_PATH"
echo "[openship-mail] using TLS certificate for mail.$MAIL_BASE_DOMAIN from $MAIL_CERT_DIR"
