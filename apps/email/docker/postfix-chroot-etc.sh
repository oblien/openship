#!/usr/bin/env bash
# Keep the DNS/NSS view used by chrooted Postfix services in sync with the
# running container. /var/spool/postfix is a persistent bind mount, so the copy
# made by iRedMail while the image is built is hidden at runtime (GH-686).
set -euo pipefail

source_etc="${1:-/etc}"
chroot_etc="${2:-/var/spool/postfix/etc}"

install -d -m 0755 "$chroot_etc"

copy_atomic() { # <name> [required]
  local name="$1" required="${2:-false}"
  local source="$source_etc/$name" target="$chroot_etc/$name" temporary

  if [ ! -r "$source" ]; then
    if [ "$required" = true ]; then
      echo "[openship-mail] FATAL: Postfix chroot source $source is not readable" >&2
      return 1
    fi
    return 0
  fi

  temporary="$(mktemp "$chroot_etc/.${name}.XXXXXX")"
  if ! cat -- "$source" > "$temporary"; then
    rm -f -- "$temporary"
    echo "[openship-mail] FATAL: could not copy $source into the Postfix chroot" >&2
    return 1
  fi
  chmod 0644 "$temporary"
  mv -f -- "$temporary" "$target"
}

# DNS is load-bearing: without it reject_unknown_helo_hostname and DNSBL checks
# temporarily reject legitimate inbound mail. Fail before Postfix starts rather
# than bringing up an SMTP server that rejects every sender.
if [ ! -s "$source_etc/resolv.conf" ]; then
  echo "[openship-mail] FATAL: $source_etc/resolv.conf is missing or empty; Postfix DNS would be unavailable" >&2
  exit 1
fi
copy_atomic resolv.conf true

# These complete libc's normal name/service lookup view inside the chroot. Some
# minimal images omit host.conf or localtime, so only the resolver is mandatory.
for file in hosts nsswitch.conf services host.conf localtime; do
  copy_atomic "$file"
done

echo "[openship-mail] reconciled Postfix chroot DNS/NSS files in $chroot_etc"
