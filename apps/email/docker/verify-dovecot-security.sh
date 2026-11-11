#!/bin/sh
set -eu

# Debian 12 backports the Dovecot/Pigeonhole fixes without changing the 2.3
# configuration format. DLA-4873-1 includes CVE-2026-40013 and CVE-2026-42007.
# https://security-tracker.debian.org/tracker/CVE-2026-40013
minimum='1:2.3.19.1+dfsg1-2.1+deb12u7'
for package in dovecot-core dovecot-sieve dovecot-managesieved; do
    status=$(dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null) || status='missing'
    version=$(dpkg-query -W -f='${Version}' "$package" 2>/dev/null) || version=''
    if [ "$status" != installed ] || ! dpkg --compare-versions "$version" ge "$minimum"; then
        printf 'FATAL: %s must be installed at %s or newer (found %s, status %s).\n' \
            "$package" "$minimum" "${version:-none}" "$status" >&2
        exit 1
    fi
    printf 'openship-mail: verified security updates for %s %s\n' "$package" "$version"
done
